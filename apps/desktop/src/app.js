import {
  createNoticeStore,
  errorNotice,
  conditionNotices,
  safeDetails,
} from "./notice-contract.js";
import { fileIcon } from "./file-icons.js";
const folderPages = new Map();
let folderCacheEpoch = 0;
const folderPageKey = (route) =>
  `${status?.id}:${status?.hubId || status?.id}:${route}`;
function knownFolderPage(route) {
  return folderPages.get(folderPageKey(route));
}
async function readFolderPage(route, pending = false) {
  if (pending) return knownFolderPage(route);
  try {
    return await api(route);
  } catch (error) {
    const known = knownFolderPage(route);
    if (known && error.status !== 401 && error.status !== 403) return known;
    throw error;
  }
}
// A replica can delete locally before the hub accepts its next sync. Keep that
// revision hidden across cached reads/restarts; a restored newer revision wins.
let galleryDeletions;
try {
  galleryDeletions = JSON.parse(
    localStorage.getItem("arca-gallery-deletions") || "{}",
  );
  if (
    !galleryDeletions ||
    typeof galleryDeletions !== "object" ||
    Array.isArray(galleryDeletions)
  )
    galleryDeletions = {};
} catch {
  galleryDeletions = {};
}
function galleryDeletionKey(volume, path) {
  return JSON.stringify([status.id, status.hubId || status.id, volume, path]);
}
function rememberGalleryDeletion(target) {
  galleryDeletions[galleryDeletionKey(target.volume, target.path)] = Number(
    target.rev,
  );
  try {
    localStorage.setItem(
      "arca-gallery-deletions",
      JSON.stringify(galleryDeletions),
    );
  } catch {
    /* Session filtering still works without storage. */
  }
}
function visibleGalleryPage(route, data) {
  const volume = new URLSearchParams(route.split("?")[1]).get("volume");
  return {
    ...data,
    items: data.items.filter((item) => {
      const deleted = galleryDeletions[galleryDeletionKey(volume, item.path)];
      return deleted === undefined || Number(item.rev) > deleted;
    }),
  };
}
const galleryPages = new Map();
let galleryEpoch = 0;
function clearGalleryPages() {
  galleryEpoch++;
  galleryPages.clear();
  void galleryDisk()
    .then((db) => {
      if (!db) return;
      const store = db.transaction("views", "readwrite").objectStore("views");
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if (cursor.result.key.startsWith("page:")) cursor.result.delete();
        cursor.result.continue();
      };
    })
    .catch(() => {});
}
const native = Boolean(window.__TAURI__?.core.invoke);
const APP_VERSION = "0.5.5";
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
  return `<span class="pill ${state}${symbol === "busy" ? " busy-status" : ""}">${symbol === "busy" ? busyIcon() : icon(symbol)}${escape(label)}</span>`;
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
const setting = (name, description, control = "", leading = "") =>
  `<div class="setting-row">${leading}<div class="row-main"><strong>${name}</strong><p>${description}</p></div>${control}</div>`;
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
let activeRequests = 0;
let brandShowTimer = null, brandHideTimer = null, brandShownAt = 0;
function updateBrandActivity() {
  const mark = $(".sidebar .brand-mark");
  if (!mark) return;
  const active = activeRequests > 0 || busy ||
    document.body.classList.contains("view-loading") ||
    (!status?.hubUnavailable && ["syncing", "scanning"].includes(status?.phase));
  const paint = (visible) => {
    if (!mark.isConnected) return;
    mark.classList.toggle("is-busy", visible);
    mark.setAttribute("aria-label", visible ? "Arca: updating" : "Arca");
    mark.setAttribute("aria-busy", String(visible));
    const indicator = mark.querySelector(".brand-busy");
    if (visible && indicator && !indicator.firstChild) indicator.innerHTML = busyIcon();
  };
  if (active) {
    clearTimeout(brandHideTimer);
    brandHideTimer = null;
    if (!brandShowTimer && !mark.classList.contains("is-busy"))
      brandShowTimer = setTimeout(() => {
        brandShowTimer = null;
        brandShownAt = Date.now();
        paint(true);
      }, 300);
  } else {
    clearTimeout(brandShowTimer);
    brandShowTimer = null;
    if (mark.classList.contains("is-busy")) {
      if (!brandHideTimer) brandHideTimer = setTimeout(() => {
        brandHideTimer = null;
        paint(false);
      }, Math.max(0, 500 - (Date.now() - brandShownAt)));
    } else paint(false);
  }
}
const api = (route, body) => {
  const cacheKey = folderPageKey(route),
    cacheEpoch = folderCacheEpoch;
  const showActivity = body !== undefined || !["/v1/status", "/v1/web-approvals"].includes(route);
  if (showActivity) activeRequests++;
  updateBrandActivity();
  return invoke("api", {
    route,
    method: body === undefined ? "GET" : "POST",
    body: body ?? null,
  })
    .then((value) => {
      if (body !== undefined) clearGalleryPages();
      if (route === "/v1/delete-file" && body) rememberGalleryDeletion(body);
      if (
        cacheEpoch === folderCacheEpoch &&
        body === undefined &&
        /^\/v1\/(browse|activity)\?/.test(route)
      ) {
        folderPages.set(cacheKey, value);
        while (folderPages.size > 100)
          folderPages.delete(folderPages.keys().next().value);
      }
      return value;
    })
    .catch((error) => {
      if (error?.status === 401 || error?.status === 403) {
        folderCacheEpoch++;
        folderPages.clear();
      }
      throw error instanceof Error
        ? error
        : new Error(
            typeof error === "string"
              ? error
              : error?.message || "Request failed. Try again.",
          );
    })
    .finally(() => {
      if (showActivity) activeRequests--;
      updateBrandActivity();
    });
};
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
  catalogLoaded = false,
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
    navigate(async () => {
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
    (m) =>
      m.machineId !== status.id &&
      (m.folderIds?.includes(v.id) || m.albumFolderIds?.includes(v.id)),
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
          `<div class="copy-row">${icon(m.isHub ? "server" : /android|ios/.test(m.platform) ? "smartphone" : "monitor")}<strong>${escape(m.name)}</strong><span class="tag ${m.machineId === status.id ? "self" : m.isHub ? "hub" : ""}">${m.machineId === status.id ? "This machine" : m.revoked ? "Access revoked" : m.albumFolderIds?.includes(v.id) ? "Album source" : m.isHub ? "Hub" : "Replica"}</span></div>`,
      )
      .join("") +
    (copiesUnavailable
      ? '<p class="hint">Hub unavailable. Showing last known copies.</p>'
      : !copiesRoster
        ? scaffoldRow("compact")
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

const noticeStore = createNoticeStore();
function noticeMarkup(item) {
  const action =
    item.action &&
    `<button class="notice-link" data-action="${escape(item.action)}" data-id="${escape(item.volume || "")}">${escape(item.actionLabel || "Review")}</button>`;
  return `<article class="notice-card notice-${item.kind}" data-notice-id="${escape(item.id)}" role="${item.kind === "info" ? "status" : "alert"}"><div class="notice-main">${icon(item.icon || (item.kind === "info" ? "circle-check" : "circle-alert"))}<div class="notice-content"><strong>${escape(item.title)}</strong>${item.body ? `<p>${escape(item.body)}</p>` : ""}${action || item.kind !== "info" ? `<div class="notice-actions">${action || ""}${item.kind !== "info" ? `<button class="notice-link notice-muted" data-action="dismiss">Dismiss</button>` : ""}</div>` : ""}</div><button class="notice-close" data-action="dismiss" aria-label="Dismiss notification">${icon("x")}</button></div>${item.details ? `<details class="notice-details"><summary>${icon("chevron-right")}<span>Details</span><button class="notice-copy notice-link" data-action="copy-notice">Copy</button></summary><pre>${escape(safeDetails(item.details))}</pre></details>` : ""}</article>`;
}
function renderNotices() {
  const box = $("#notice"),
    items = noticeStore.snapshot();
  const ids = new Set(items.map((n) => n.id));
  for (const card of box.children)
    if (!ids.has(card.dataset.noticeId)) card.remove();
  for (const item of items) {
    const old = Array.from(box.children).find(
      (c) => c.dataset.noticeId === item.id,
    );
    const markup = noticeMarkup(item);
    if (old?.dataset.markup === markup) continue;
    const template = document.createElement("template");
    template.innerHTML = markup;
    const card = template.content.firstElementChild;
    card.dataset.markup = markup;
    if (old) {
      const details = card.querySelector("details");
      if (details) details.open = Boolean(old.querySelector("details")?.open);
      old.replaceWith(card);
    } else {
      card.classList.add("notice-enter");
      box.append(card);
    }
  }
  box.hidden = !items.length;
  icons();
}
noticeStore.subscribe(renderNotices);
function notice(message, error = false, options = {}) {
  const item = error
    ? errorNotice(message, { hubName: status?.hubName || "your hub" })
    : { kind: "info", title: message };
  return noticeStore.push({ ...item, ...options });
}
let actionQueue = null;
let activeUIRequests = 0;
const pendingControls = new WeakSet();
function action(work, control) {
  if (control && pendingControls.has(control)) return Promise.resolve();
  if (control) {
    pendingControls.add(control);
    control.disabled = true;
  }
  const execute = () =>
    performAction(async () => {
      try {
        await work();
      } finally {
        if (control) {
          pendingControls.delete(control);
          control.disabled = false;
        }
      }
    }, true);
  const result = actionQueue ? actionQueue.then(execute) : execute();
  actionQueue = result;
  void result.finally(() => {
    if (actionQueue === result) actionQueue = null;
  });
  return result;
}
function navigate(work) {
  return performAction(work, false);
}
function background(work) {
  return performAction(work, false, false);
}
async function performAction(work, exclusive, track = true) {
  statusRequestSerial++; // Discard status reads started before this user action.
  if (track) {
    activeUIRequests++;
    document.body.setAttribute("aria-busy", "true");
  }
  if (exclusive) busy = true;
  updateBrandActivity();
  try {
    await work();
  } catch (e) {
    if (!native && e.status === 401) {
      await showLogin("Your session has ended. Enter a new web access code.");
      return;
    }
    const message = e?.message || String(e);
    if ($("#dialog").open) {
      $("#dialog-error").innerHTML = noticeMarkup({
        ...errorNotice(message),
        id: "dialog-error",
        action: null,
      });
      $("#dialog-error").hidden = false;
    } else {
      notice(message, true, {
        id: e.transportError && e.readOnly ? "connection" : "action",
        action: e.transportError && e.readOnly ? "refresh" : null,
      });
    }
  } finally {
    if (exclusive) busy = false;
    if (track) {
      activeUIRequests--;
      document.body.setAttribute("aria-busy", String(activeUIRequests > 0));
    }
    updateBrandActivity();
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
  if (status.hubUnavailable) return ["Offline", "wa", "wifi-off"];
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
  const [label, color, symbol] = (status.hubUnavailable && status.phase !== "paused"
    ? ["Offline", "wa", "wifi-off"]
    : status.phase === "idle" && conflicts
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
      : status.lastSync ? `Last sync ${relative(status.lastSync)}` : "Not synced yet";
  $("#last-sync").hidden = label === "Up to date";
  const backup = $("#backup-summary");
  const hubBackups = (status.devices || []).filter(device => !device.revoked && device.backup_enabled);
  const reported = hubBackups.filter(device => device.backup_updated).length;
  const backupLabel = status.role === "hub"
    ? reported ? `${reported} ${reported === 1 ? "backup" : "backups"} reported` : hubBackups.length ? "Backup pending" : "No backup reported"
    : status.backup?.enabled ? status.backup.error ? "Full backup needs attention" : status.backup.lastSync ? "Full backup enabled" : "Full backup pending" : "Full backup off";
  backup.hidden = status.role !== "hub" && !status.hub;
  backup.dataset.action = status.role === "hub" ? "machines" : "backup-settings";
  backup.innerHTML = icon(status.role === "hub" ? reported ? "shield-check" : "shield" : status.backup?.enabled ? "shield-check" : "shield") + `<span>${backupLabel}</span>`;
  backup.title = status.role === "hub" ? "View backup reports from your machines" : "Manage this machine’s additional full copy of the hub and its history";
  $("#conflict-count").textContent = conflicts;
  $("#conflict-count").hidden = !conflicts;
  document.querySelectorAll("nav [data-view]").forEach((el) => {
    const active = el.dataset.view === view;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  $(".sign-out").hidden = native;
  updateSyncControls();
  icons();
}
function synchronizationError() {
  const errors = (status.volumes || [])
    .filter((volume) => volume.sync?.error)
    .map((volume) => `${volume.name}: ${volume.sync.error}`);
  return errors.length ? errors.join("\n") : status.error;
}
function viewRefreshSignature(status, view, detailId) {
  const volumes =
    view === "folders" && detailId
      ? status.volumes.filter((volume) => volume.id === detailId)
      : status.volumes;
  return JSON.stringify(
    [
      view,
      detailId,
      volumes.map(({ files, bytes, sync, ...volume }) => ({
        ...volume,
        ...(detailId ? { files, bytes } : {}),
        sync: sync && { state: sync.state, error: sync.error },
      })),
      status.phase,
      !!status.hubUnavailable,
      view === "devices" ? status.backup : null,
      view === "devices"
        ? status.devices?.map(({ last_seen, ...device }) => ({
            ...device,
            seen: !!last_seen,
          }))
        : null,
    ],
    (key, value) =>
      ["lastCompleted", "last_sync"].includes(key) ? undefined : value,
  );
}

let statusRequestSerial = 0;
async function refresh(renderView = true) {
  const request = ++statusRequestSerial;
  const next = await api("/v1/status");
  if (request !== statusRequestSerial) return lastSignature;
  status = next;
  updateBrandActivity();
  if (status.needsSetup || status.onboarding) {
    ready = false;
    onboarding ||= {
      step: status.onboarding
        ? status.role === "hub" || status.hub
          ? 3
          : 2
        : -1,
      name: status.onboarding ? status.name : "",
      role: status.onboarding ? status.role : "replica",
      root: status.root,
      url: status.hub || "",
      code: "",
      initialized: !!status.onboarding,
      paired: !!status.hub,
    };
    renderOnboarding();
    return;
  }
  noticeStore.clear("connection");
  ready = true;
  document.body.classList.remove("access-mode", "onboarding-mode");
  updateShell();
  if (view === "settings" && $("#backup-completion")) {
    $("#backup-completion").outerHTML = backupCompletionSetting();
    icons();
  }
  if (detailId && view === "folders") refreshCopies();
  if (!renderView) {
    for (const row of document.querySelectorAll(".folder-card[data-id]")) {
      const volume = status.volumes.find((v) => v.id === row.dataset.id);
      if (!volume) continue;
      const p =
        status.phase !== "paused" &&
        status.progress?.volume === volume.id &&
        status.progress?.path
          ? status.progress
          : null;
      row.querySelector(".meta").textContent =
        volume.sync?.error ||
        volume.policyError ||
        (p
          ? progressLabel(p)
          : `${countLabel(volume.files || 0, "file")} · ${bytes(volume.bytes)} · ${volume.path || "No visible copy selected"}`);
      let progress = row.querySelector("progress");
      if (!p) {
        progress?.remove();
        continue;
      }
      if (!progress) {
        progress = document.createElement("progress");
        row.querySelector(".row-main").append(progress);
      }
      progress.setAttribute(
        "aria-label",
        p.stage === "upload" ? "Changes sent" : "Entries checked",
      );
      if (Number.isFinite(p.filesTotal) && p.filesTotal > 0) {
        progress.max = p.filesTotal;
        progress.value = p.filesDone || 0;
      } else progress.removeAttribute("value");
    }
  }
  if (!renderView && view === "folders" && detailId) {
    const volume = status.volumes.find((v) => v.id === detailId);
    const completed = document.querySelector(
      ".folder-stats .stat:first-child p",
    );
    if (completed && volume)
      completed.textContent = volume.sync?.lastCompleted
        ? `Completed ${relative(volume.sync.lastCompleted)}`
        : "No completed sync yet";
  }
  const syncError = synchronizationError();
  const conditions = conditionNotices({ ...status, error: syncError });
  noticeStore.reconcile(
    conditions.map((item) => ({
      ...item,
      action: !item.action
        ? null
        : item.action === "review"
          ? "folder-conflicts"
          : item.action === "folder"
            ? "folder-detail"
            : item.action === "backup"
              ? "backup-settings"
              : item.action === "pair"
                ? "replacement-hub"
                : "sync",
    })),
  );
  const signature = viewRefreshSignature(status, view, detailId);
  if (renderView) {
    await render();
    lastSignature = signature;
  }
  return signature;
}
function folderRetentionSummary(volume) {
  const mode =
    (status.role === "hub"
      ? status.folderRetention?.[volume.id]
      : (catalog.find((row) => row.id === volume.id)?.historyRetention ??
        volume.historyRetention)) || "1m";
  const label =
    {
      off: "Off",
      "1d": "On · 1 day",
      "1w": "On · 1 week",
      "1m": "On · 30 days",
      forever: "Forever",
    }[mode] || "Unknown";
  return `<div class="stat folder-history-status"><span>Revision history</span>${status.role === "hub" ? folderRetentionControl(volume.id) : `<strong>${escape(label)}</strong>`}<p>${mode === "off" ? "Current files only" : "Older revisions kept"}</p></div>`;
}
function folderRetentionControl(id) {
  const mode = status.folderRetention?.[id] || "1m";
  return `<div id="folder-retention" data-volume="${escape(id)}">${segmented(
    "Revision history retention",
    [
      ["off", "Off"],
      ["1d", "1d"],
      ["1w", "1w"],
      ["1m", "30d"],
      ["forever", "Forever"],
    ].map(([value, label]) => ({
      label,
      action: "folder-retention",
      id: value,
      active: mode === value,
    })),
    "segmented-compact",
  )}</div>`;
}
async function changeFolderRetention(mode, control) {
  const group = control.closest("#folder-retention");
  const id = group.dataset.volume;
  if (mode === (status.folderRetention?.[id] || "1m")) return;
  const buttons = [...group.querySelectorAll("button")];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const preview = await api("/v1/folder-retention", { id, mode });
    const apply = () =>
      api("/v1/folder-retention", {
        id,
        mode,
        apply: true,
        confirmation: preview.confirmation,
      });
    if (preview.remove) {
      modal(
        modalHeader(
          "Remove older revisions?",
          `${preview.remove} older revisions will be permanently removed. Current files are kept.`,
          "history",
        ),
        apply,
        "Apply retention",
      );
      $("#submit-dialog").classList.add("danger");
    } else {
      await apply();
      await refresh();
    }
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

function updateSyncControls() {
  const root = $("#sync-controls");
  const linked = status.role === "hub" || Boolean(status.hub);
  const paused = status.phase === "paused";
  const syncing = !status.hubUnavailable && ["syncing", "scanning"].includes(status.phase);
  const signature = `${linked}:${paused}:${syncing}`;
  if (root.dataset.state === signature) return;
  root.dataset.state = signature;
  root.hidden = !linked;
  const pauseLabel = paused ? "Resume sync" : "Pause sync";
  root.innerHTML = !linked ? "" :
    iconAction(pauseLabel, "pause", paused ? "play" : "pause") +
    (syncing ? "" : iconAction("Sync now", "sync", "refresh-cw", paused));
}
function progressLabel(p) {
  const sending = p.stage === "upload" || p.direction === "upload";
  const count = Number.isFinite(p.filesTotal)
    ? `${(p.filesDone || 0).toLocaleString("en")} / ${p.filesTotal.toLocaleString("en")} ${sending ? "changes sent" : "entries checked"}`
    : `${(p.filesDone || 0).toLocaleString("en")} entries checked`;
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
              "folder-problem",
              v.id,
              "secondary small-button",
              "circle-alert",
            )
          : "";
  let meta = available
    ? `${countLabel(v.files || 0, "file")} · ${bytes(v.bytes)}`
    : `${countLabel(v.files, "file")} · ${bytes(v.bytes)} · ${escape(v.path || "No visible copy selected")}`;
  if (p) meta = escape(progressLabel(p));
  if (v.sync?.error || v.policyError)
    meta = escape(v.sync?.error || v.policyError);
  return `<article class="folder-card ${available ? "unselected" : ""}" ${available ? "" : `data-action="folder-detail" data-id="${escape(v.id)}" tabindex="0" role="button" aria-label="Open ${escape(v.name)} details"`}><div class="tile"${state[2] === "busy" ? ` role="status" aria-label="${state[0]}"` : ""}>${state[2] === "busy" ? busyIcon() : icon(v.gallery ? "images" : "folder")}</div><div class="row-main"><strong>${escape(v.name)}</strong><p class="meta">${meta}</p>${p ? `<progress aria-label="${p.stage === "upload" ? "Changes sent" : "Entries checked"}" ${p.filesTotal > 0 ? `value="${Number(p.filesDone) || 0}" max="${Number(p.filesTotal)}"` : ""}></progress>` : ""}</div>${available ? selectFolderButton(v.id) : `${problemAction || (v.conflicts ? button("Review", "folder-conflicts", v.id, "secondary small-button") : "")}${state[2] === "busy" || ["Up to date", "Offline"].includes(state[0]) ? "" : pill(...state)}${icon("chevron-right")}`}</article>`;
}
async function loadCatalog() {
  if (status.role !== "hub" && !status.hub) {
    catalog = [];
    catalogLoaded = false;
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
      const volume = status.volumes.find((row) => row.id === detailId);
      const summary = $(".folder-history-status");
      if (
        view === "folders" &&
        volume &&
        summary &&
        $("#content").dataset.detail === volume.id
      )
        summary.outerHTML = folderRetentionSummary(volume);
      catalogHubName = remote.name || "";
      updateShell();
    } catch {
      // Keep the last known catalog when the hub is unavailable.
    } finally {
      catalogLoaded = true;
      catalogRequest = null;
    }
  })();
  return catalogRequest;
}
// Shared loading primitives: compose existing surfaces, never invent list lengths.
function scaffoldLine(size = "medium") {
  return `<span class="scaffold-line scaffold-${size}" aria-hidden="true"></span>`;
}
function scaffoldRow(kind = "card", dashed = false) {
  return `<div class="scaffold-row scaffold-${kind} ${dashed ? "scaffold-dashed" : ""}" role="status" aria-label="Loading content"><span class="scaffold-mark" aria-hidden="true"></span><div class="scaffold-copy">${scaffoldLine("medium")}${scaffoldLine("long")}</div>${scaffoldLine("short")}</div>`;
}
function scaffoldInfo(item) {
  return `<div role="status" aria-label="Loading photo information"><div class="photo-info-summary"><p class="mono">${escape(item.path.split("/").pop())}</p>${scaffoldLine("long")}</div><section class="photo-info-section"><h3 class="section-label">Capture</h3>${scaffoldLine("medium")}${scaffoldLine("long")}<div class="photo-capture-stats">${Array.from({ length: 4 }, () => `<div>${scaffoldLine("short")}</div>`).join("")}</div></section><section class="photo-info-section"><h3 class="section-label">In Arca</h3>${scaffoldLine("long")}${scaffoldLine("medium")}</section></div>`;
}
let viewLoadSerial = 0;
const viewReads = new Map(),
  historyCache = new Map();
function viewRead(route) {
  const key = JSON.stringify([status?.id, status?.hubId, status?.hub, route]);
  if (!viewReads.has(key)) {
    const pending = api(route).finally(() => {
      if (viewReads.get(key) === pending) viewReads.delete(key);
    });
    viewReads.set(key, pending);
  }
  return viewReads.get(key);
}
let animatedRoute = null;
let navigationAnimation = null;
function motionDuration(token) {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(token),
    ) || 0
  );
}
async function render({ refreshStatus = false } = {}) {
  galleryView?.observer?.disconnect();
  galleryView?.moreObserver?.disconnect();
  galleryView?.cleanup?.();
  const loading = ++viewLoadSerial;
  const route = routeURL();
  if (location.hash !== route) window.history.pushState(null, "", route);
  document.body.classList.add("view-loading");
  updateBrandActivity();
  $("#content").setAttribute("aria-busy", "true");
  try {
    const page = renderView(true, undefined, refreshStatus);
    if (animatedRoute !== route) {
      navigationAnimation?.cancel();
      navigationAnimation = $("#content").animate?.(
        [
          { opacity: 0.65, transform: "translateY(6px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: motionDuration("--motion-enter"),
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        },
      );
      animatedRoute = route;
    }
    const serial = renderSerial;
    const request = statusRequestSerial + 1;
    const state = refreshStatus
      ? refresh(false).then(() => {
          if (
            serial === renderSerial &&
            request === statusRequestSerial &&
            ready &&
            !busy &&
            !$("#dialog").open
          )
            return renderView(false, serial);
        })
      : null;
    const results = await Promise.allSettled([page, state]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      if (loading === viewLoadSerial)
        for (const row of $("#content").querySelectorAll(".scaffold-row"))
          row.outerHTML = empty(
            "Content unavailable",
            "Try loading this view again.",
            button("Retry", "refresh", "", "secondary", "refresh-cw"),
          );
      throw failed.reason;
    }
  } finally {
    if (loading === viewLoadSerial && window.document) {
      document.body.classList.remove("view-loading");
      updateBrandActivity();
      $("#content").setAttribute("aria-busy", "false");
    }
  }
}
async function renderView(
  refreshCatalog = true,
  serial = ++renderSerial,
  trackCatalog = false,
) {
  const content = $("#content");
  if (view !== "folders" || !detailId) delete content.dataset.detail;
  if (view === "folders") {
    if (status.role === "hub" || !catalog.length) catalog = status.volumes;
    if (detailId) {
      await renderDetail();
      if (refreshCatalog && status.role !== "hub" && status.hub)
        void loadCatalog();
      icons();
      return;
    }
    const selected = status.volumes.filter((v) => v.selected),
      available = catalog.filter((v) => !selected.some((x) => x.id === v.id));
    let html = title(
      "Folders",
      status.role !== "hub" && !status.hub ? "Disconnected" : "",
      status.role !== "hub" && !status.hub
        ? button("Connect to hub…", "connect", "", "primary", "link")
        : button(
            status.role === "hub" ? "Create shared folder" : "Choose folders",
            status.role === "hub" ? "share" : "add",
            "",
            "primary",
            "folder-plus",
          ),
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
        `<div class="folder-list">${available.map((v) => folderRow(v, true)).join("")}</div>`,
      );
    if (
      status.role !== "hub" &&
      status.hub &&
      !catalogLoaded &&
      !available.length
    )
      html += section("On hub · not selected", scaffoldRow("card", true));
    content.innerHTML = html + "</div>";
    if (refreshCatalog && status.role !== "hub") {
      icons();
      const previous = JSON.stringify([catalog, catalogHubName, catalogLoaded]);
      const update = loadCatalog().then(async () => {
        if (!window.document || serial !== renderSerial) return;
        if (
          view === "folders" &&
          !detailId &&
          !$("#dialog").open &&
          previous !== JSON.stringify([catalog, catalogHubName, catalogLoaded])
        ) {
          await renderView(false, serial);
        }
      });
      // Startup and mutations must finish independently of an offline hub.
      if (trackCatalog) await update;
    }
  } else if (view === "devices") {
    await renderMachines(serial, false);
    if (refreshCatalog) await renderMachines(serial);
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
    await renderHistory(
      "",
      false,
      historyPanel,
      !historyPath || !refreshCatalog,
    );
    if (serial !== renderSerial) return;
    content.innerHTML = historyPath
      ? fileHistoryHeader() +
        `<div class="page detail-page">${fileHistorySummary()}<div class="detail-grid"><div id="history-list" class="detail-revisions">${historyPanel.innerHTML}</div>${fileHistorySide()}</div></div>`
      : title(
          "History",
          "",
          `${dropdown("history-share", "Shared folder", [{ id: "", name: "All" }, ...status.volumes.filter((v) => status.role === "hub" || v.selected)], historyVolume, "history-folder")}${segmented("History filters", filters, "history-filters")}`,
        ) +
        `<div class="page"><div id="history-list">${historyPanel.innerHTML}</div></div>`;
    icons();
    if (refreshCatalog && !historyPath) await renderHistory();
    if (serial !== renderSerial) return;
  } else {
    await renderSettings(false, serial);
    if (refreshCatalog) await renderSettings(true, serial);
  }
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
  return `<div data-action="${action}" data-id="${escape(target)}" tabindex="0" role="button" aria-label="${escape(`${action === "review-conflict" ? "Review conflict for" : "View history for"} ${v.path}`)}" class="history-row ${compact ? "compact" : ""} ${deleted ? "deleted" : conflict && !v.resolved ? "conflict" : ""}">${icon(deleted ? "trash-2" : conflict ? "git-branch" : "git-commit-horizontal")}<div><strong>${escape(v.path)}</strong><p>${deleted ? "Deleted · recoverable" : conflict ? (v.resolved ? "Conflict resolved · copy kept" : "Conflict copy retained") : `${bytes(v.size)}`}</p></div>${compact ? "" : `<span class="history-folder">${escape(v.folder || status.volumes.find((x) => x.id === v.volume)?.name || "")}</span>`}<span class="mono revision">rev ${v.rev}</span><span class="row-time">${relative(v.created)}</span><div class="row-actions">${icon("chevron-right")}</div></div>`;
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
  const canModify =
    current &&
    !current.deleted &&
    !current.directory &&
    (status.role === "hub" || volume?.selected);
  const actions = canModify
    ? `${historyPath !== ".arcaignore" ? button("Rename…", "rename-file", "", "secondary", "pencil") : ""}${button("Delete file…", "delete-file", "", "secondary danger menu-item-separated", "trash-2")}`
    : "";
  const fileMenu =
    finder || actions
      ? `<details class="details-menu file-actions-menu"><summary class="icon-button" aria-label="File actions">${icon("ellipsis")}</summary><div class="menu-items">${finder}${actions}</div></details>`
      : "";
  return `<div class="detail-head file-detail-head">${button(fileOriginFolder ? "Folder" : "History", fileOriginFolder ? "file-back-folder" : "history-back", "", "back", "chevron-left")}<div class="heading"><div class="detail-title"><div class="tile large">${icon(fileIcon(historyPath))}</div><div><h1>${escape(filename)}</h1></div></div><div class="file-header-actions">${conflictAction}${access}${fileMenu}</div></div></div>`;
}

function fileHistorySummary() {
  const current = historyVersions[0];
  if (current && !current.created)
    return `<div class="file-history-summary"><p class="hint">Local copy · ${bytes(current.size)} · hub history unavailable</p></div>`;
  const available = current && !current.deleted;
  return `<div class="file-history-summary"><div class="stats"><div class="stat"><span>Status on hub</span><strong>${current ? (current.deleted ? "Deleted" : current.resolved ? "Resolved" : "Available") : "Unknown"}</strong></div><div class="stat"><span>File size</span><strong>${available ? bytes(current.size) : "—"}</strong><p>Latest accepted version</p></div><div class="stat"><span>Latest revision</span><strong class="mono">${current ? `rev ${current.rev}` : "—"}</strong><p>${current ? escape(authorName(current.author)) : "No retained revisions"}</p></div><div class="stat"><span>Last changed</span><strong>${current ? date(current.created) : "—"}</strong><p>Accepted by the hub</p></div></div></div>`;
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
  return `<aside class="detail-side">${section("File location", `<div class="panel"><strong>${escape(volume?.name || "Shared folder")}</strong><p class="path">${escape(historyPath)}</p>${folderLink}</div>`)}</aside>`;
}

// Disposable persistent view data, scoped by machine/hub. Never store credentials or tickets.
let galleryDatabase;
function galleryDisk() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return (galleryDatabase ||= new Promise((resolve) => {
    const request = indexedDB.open("arca-gallery", 1);
    request.onupgradeneeded = () =>
      request.result
        .createObjectStore("views", { keyPath: "key" })
        .createIndex("time", "time");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  }));
}
async function storedGallery(key, value) {
  try {
    const db = await galleryDisk();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(
        "views",
        value === undefined ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("views");
      let result = null;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => resolve(null);
      if (value === undefined) {
        const read = store.get(key);
        read.onsuccess = () => {
          result = read.result?.value || null;
        };
      } else {
        if (JSON.stringify(value).length > 300000) return;
        store.put({ key, value, time: Date.now() });
        const count = store.count();
        count.onsuccess = () => {
          let excess = count.result - 128;
          if (excess <= 0) return;
          const cursor = store.index("time").openCursor();
          cursor.onsuccess = () => {
            if (cursor.result && excess-- > 0) {
              cursor.result.delete();
              cursor.result.continue();
            }
          };
        };
      }
    });
  } catch {
    return null;
  }
}
function clearStoredGallery() {
  void galleryDisk()
    .then((db) => {
      if (db) db.transaction("views", "readwrite").objectStore("views").clear();
    })
    .catch(() => {});
}
// Content-addressed session cache survives leaving a gallery; never persisted with credentials.
const photoCaches = {
  thumb: { entries: new Map(), bytes: 0, limit: 48 * 1024 ** 2, count: 2000 },
  large: { entries: new Map(), bytes: 0, limit: 16 * 1024 ** 2, count: 8 },
};
const photoRequests = new Map();
async function galleryPage(route, fresh = false) {
  const key = `${status.id}:${status.hubId || status.id}:${route}`;
  const epoch = galleryEpoch;
  const cached =
    galleryPages.get(key) || (!fresh && (await storedGallery(`page:${key}`)));
  const refresh = async () => {
    const data = await api(route);
    if (!data.indexing && epoch === galleryEpoch) {
      galleryPages.delete(key);
      const entry = { time: Date.now(), data };
      galleryPages.set(key, entry);
      void storedGallery(`page:${key}`, entry);
      while (galleryPages.size > 40)
        galleryPages.delete(galleryPages.keys().next().value);
    }
    return data;
  };
  if (cached && !fresh) {
    if (
      (!galleryPages.has(key) || Date.now() - cached.time > 15000) &&
      !cached.refreshing
    ) {
      cached.refreshing = true;
      void refresh().catch(() => galleryPages.delete(key));
    }
    return visibleGalleryPage(route, cached.data);
  }
  return visibleGalleryPage(route, await refresh());
}
async function cachedPhoto(route) {
  const pool = photoCaches[route.includes("size=large") ? "large" : "thumb"];
  const photoCache = pool.entries;
  const key = `${status.hubId || status.id}:${route}`;
  if (photoCache.has(key)) {
    const value = photoCache.get(key);
    photoCache.delete(key);
    if (!value.expires || value.expires > Date.now() + 60000) {
      photoCache.set(key, value);
      return value;
    }
    pool.bytes -= value.data.length * 2;
  }
  if (!route.includes("size=large")) {
    const stored = await storedGallery(`thumb:${key}`);
    if (stored?.data) return stored;
  }
  if (photoRequests.has(key)) return photoRequests.get(key);
  const pending = api(
    route.includes("size=large")
      ? route.replace("/gallery/preview?", "/gallery/preview-url?")
      : route,
  )
    .then((value) => {
      if (value.url) value = { data: value.url, expires: value.expires };
      if (photoRequests.get(key) !== pending || !value.data) return value;
      if (
        !route.includes("size=large") &&
        value.data?.startsWith("data:image/")
      )
        void storedGallery(`thumb:${key}`, value);
      photoCache.set(key, value);
      pool.bytes += value.data.length * 2;
      while (pool.bytes > pool.limit || photoCache.size > pool.count) {
        const oldest = photoCache.keys().next().value;
        pool.bytes -= photoCache.get(oldest).data.length * 2;
        photoCache.delete(oldest);
      }
      return value;
    })
    .finally(() => {
      if (photoRequests.get(key) === pending) photoRequests.delete(key);
    });
  photoRequests.set(key, pending);
  return pending;
}
let galleryView = null,
  folderViewId = null,
  folderReturn = { tab: "files", scroll: 0 };
function mountGallery(volume) {
  galleryView?.observer?.disconnect();
  galleryView?.moreObserver?.disconnect();
  galleryView?.cleanup?.();
  const root = $("#photo-gallery");
  if (!root) return;
  const state = (galleryView = {
    volume,
    root,
    items: [],
    paths: new Set(),
    selection: new Map(),
    next: "",
    loading: false,
    month: "",
    queue: [],
    workers: 0,
  });
  const current = () => galleryView === state && root.isConnected;
  let hoverVideo = null;
  const stopHover = () => {
    const hover = hoverVideo;
    hoverVideo = null;
    if (!hover) return;
    clearTimeout(hover.timer);
    if (hover.video) {
      hover.video.pause();
      hover.video.removeAttribute("src");
      hover.video.load();
      hover.video.remove();
    }
  };
  state.stopHover = stopHover;
  const previewVideo = (tile, item, event) => {
    if (
      event.pointerType !== "mouse" ||
      document.hidden ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      $("#dialog").open ||
      state.selection.size
    )
      return;
    stopHover();
    const hover = (hoverVideo = {});
    hover.timer = setTimeout(async () => {
      try {
        const playback = await api(
          "/v1/gallery/playback?" +
            new URLSearchParams({
              volume,
              path: item.path,
              hash: item.hash,
            }),
        );
        if (hoverVideo !== hover || !current() || !tile.isConnected) return;
        const video = (hover.video = document.createElement("video"));
        video.className = "photo-hover-video";
        video.muted = true;
        video.playsInline = true;
        video.preload = "none";
        video.setAttribute("aria-hidden", "true");
        video.onloadeddata = () => video.classList.add("ready");
        video.ontimeupdate = () => {
          if (video.currentTime >= 3 && hoverVideo === hover) stopHover();
        };
        video.onended = video.onerror = () => {
          if (hoverVideo === hover) stopHover();
        };
        video.src = playback.url;
        tile.querySelector(".photo-open").after(video);
        await video.play();
      } catch {
        if (hoverVideo === hover) stopHover();
      }
    }, 250);
  };
  const hideHover = () => {
    if (document.hidden) stopHover();
  };
  document.addEventListener("visibilitychange", hideHover);

  const previewRoute = (item, large = false) =>
    "/v1/gallery/preview?" +
    new URLSearchParams({
      volume,
      path: item.path,
      hash: item.hash,
      ...(large ? { size: "large" } : {}),
    });
  state.previewRoute = previewRoute;
  async function drain() {
    if (!current() || state.workers >= 3 || !state.queue.length) return;
    const tile = state.queue.shift();
    if (tile.dataset.visible === "false") {
      delete tile.dataset.queued;
      return drain();
    }
    state.workers++;
    const item = state.items[Number(tile.dataset.photo)];
    try {
      const result = await cachedPhoto(previewRoute(item));
      if (current() && tile.isConnected && tile.dataset.visible !== "false") {
        if (result.data) {
          const img = document.createElement("img");
          img.alt = "";
          img.src = result.data;
          img.decoding = "async";
          img.onload = () => {
            if (!current() || !img.naturalHeight) return;
            const ratio = img.naturalWidth / img.naturalHeight;
            if (tile.photoRatio !== ratio) {
              tile.photoRatio = ratio;
              layoutPhotos();
            }
          };
          tile.querySelector(".photo-open").replaceChildren(img);
        } else tile.querySelector(".photo-open").innerHTML = icon("image-off");
        icons();
      }
    } catch {
      if (tile.isConnected)
        tile.querySelector(".photo-open").innerHTML = icon("image-off");
    } finally {
      delete tile.dataset.queued;
      state.workers--;
      drain();
    }
  }
  state.observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const tile = entry.target;
              tile.dataset.visible = String(entry.isIntersecting);
              if (entry.isIntersecting) {
                if (!tile.dataset.queued && !tile.querySelector("img")) {
                  tile.dataset.queued = "true";
                  state.queue.push(tile);
                  drain();
                }
              } else tile.querySelector(".photo-open").replaceChildren();
            }
          },
          { rootMargin: "300px" },
        )
      : null;
  const toolbar = $("#photo-selection");
  const heading = $(".detail-head > .heading");
  heading.classList.add("gallery-selection-host");
  heading.append(toolbar);
  toolbar.querySelector(".photo-selection-delete").hidden = !galleryCanDelete();
  function updateSelection() {
    toolbar.hidden = !state.selection.size;
    heading.classList.toggle(
      "has-photo-selection",
      Boolean(state.selection.size),
    );
    toolbar.querySelector(".photo-selection-count").textContent =
      `${state.selection.size} selected`;
    root.classList.toggle("selecting", Boolean(state.selection.size));
    for (const tile of root.querySelectorAll(".photo-thumb")) {
      const selected = state.selection.has(
        state.items[Number(tile.dataset.photo)].path,
      );
      tile.classList.toggle("selected", selected);
      tile
        .querySelector(".photo-select")
        .setAttribute("aria-pressed", String(selected));
    }
    sizeTimeline();
  }
  function togglePhoto(item) {
    if (state.selection.has(item.path)) state.selection.delete(item.path);
    else state.selection.set(item.path, item);
    updateSelection();
  }
  toolbar.querySelector(".photo-selection-clear").onclick = () => {
    state.selection.clear();
    updateSelection();
  };
  toolbar.querySelector(".photo-selection-delete").onclick = () =>
    deleteGalleryPhotos([...state.selection.values()]);
  state.updateSelection = updateSelection;
  state.removePhoto = (item) => {
    item.deleted = true;
    state.selection.delete(item.path);
    for (const tile of root.querySelectorAll(".photo-thumb")) {
      if (state.items[Number(tile.dataset.photo)].path !== item.path) continue;
      state.observer?.unobserve(tile);
      state.queue = state.queue.filter((queued) => queued !== tile);
      tile.remove();
    }
    for (const group of root.querySelectorAll(".photo-day"))
      if (!group.querySelector(".photo-thumb")) group.remove();
    updateSelection();
    layoutPhotos();
    if (!root.querySelector(".photo-thumb") && !state.next)
      root.querySelector(".photo-days").innerHTML = empty(
        "No photos yet",
        "Photos uploaded to this folder will appear here.",
        "",
        "images",
      );
  };
  // Fit each complete row to the available width. The last row never grows
  // beyond the target height, so sparse months keep ordinary-sized photos.
  function layoutPhotos() {
    if (!current()) return;
    for (const grid of root.querySelectorAll(".photo-grid")) {
      const width = grid.clientWidth;
      if (!width) continue;
      const gap = 6;
      const target = width < 600 ? 120 : 180;
      const tiles = [...grid.children];
      let row = [],
        sum = 0;
      const place = (complete) => {
        const height = Math.min(
          complete ? target * 1.25 : target,
          (width - gap * (row.length - 1)) / sum,
        );
        for (const tile of row) {
          tile.style.setProperty(
            "--photo-width",
            `${Math.max(1, Math.floor(height * (tile.photoRatio || 1.5) * 100) / 100)}px`,
          );
          tile.style.setProperty("--photo-height", `${height}px`);
        }
        row = [];
        sum = 0;
      };
      for (const tile of tiles) {
        row.push(tile);
        sum += tile.photoRatio || 1.5;
        if (sum * target + gap * (row.length - 1) >= width) place(true);
      }
      if (row.length) place(false);
    }
  }
  function addItems(items) {
    for (const item of items) {
      if (state.paths.has(item.path)) continue;
      state.paths.add(item.path);
      const index = state.items.push(item) - 1;
      const day = (item.date || item.captured)?.slice(0, 7) || "unknown";
      let group = [...root.querySelectorAll(".photo-day")].find(
        (el) => el.dataset.day === day,
      );
      if (!group) {
        group = document.createElement("section");
        group.className = "photo-day";
        group.dataset.day = day;
        const heading =
          day === "unknown"
            ? "Date unknown"
            : new Date(
                day + (day.length === 7 ? "-01" : "") + "T12:00:00",
              ).toLocaleDateString("en", {
                year: "numeric",
                month: "long",
              });
        group.innerHTML = `<h2>${escape(heading)}</h2><div class="photo-grid"></div>`;
        root.querySelector(".photo-days").append(group);
      }
      const tile = document.createElement("div");
      tile.className = "photo-thumb";
      tile.photoRatio = state.ratios?.get(item.path);
      tile.dataset.photo = index;
      tile.title = `${galleryPhotoDate(item)}${item.dateSource === "date added" ? " · Date added to Arca" : ""}`;
      const filename = escape(item.path.split("/").pop());
      tile.innerHTML = `<button type="button" class="photo-open" aria-label="Open ${filename}">${icon(item.kind === "video" ? "play" : "image")}</button>${item.kind === "video" ? `<span class="photo-video-badge" aria-label="Video">${icon("video")}</span>` : ""}<button type="button" class="photo-select" aria-label="Select ${filename}" aria-pressed="${state.selection.has(item.path)}">${icon("check")}</button>`;
      if (item.kind === "video") {
        tile.onpointerenter = (event) => previewVideo(tile, item, event);
        tile.onpointerleave = stopHover;
      }
      tile.querySelector(".photo-open").onclick = () =>
        state.selection.size ? togglePhoto(item) : openGalleryPhoto(index);
      tile.querySelector(".photo-select").onclick = () => togglePhoto(item);
      group.querySelector(".photo-grid").append(tile);
      if (item.kind === "image" || item.kind === "video") {
        if (state.observer) state.observer.observe(tile);
        else {
          state.queue.push(tile);
          drain();
        }
      }
    }
    updateSelection();
    layoutPhotos();
    icons();
  }
  function updateTimeline(data) {
    const rail = root.querySelector(".photo-timeline");
    if (data.timeline && !rail.children.length) {
      let year = "";
      for (const date of data.timeline) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.month = date.month;
        const label = new Date(date.month + "-01T12:00:00").toLocaleDateString(
          "en",
          { month: "short", year: "numeric" },
        );
        button.dataset.label = label;
        button.title = `${label} · ${date.count} photos`;
        button.setAttribute("aria-label", `Go to ${label}`);
        button.textContent =
          year !== date.month.slice(0, 4) ? date.month.slice(0, 4) : "";
        button.innerHTML = `<span class="photo-year">${button.textContent}</span><span class="photo-date-dot"></span><span class="photo-date-label">${label}</span>`;
        year = date.month.slice(0, 4);
        button.onclick = () => {
          if (state.loading || state.refreshing) return;
          state.observer?.disconnect();
          state.items = [];
          state.paths.clear();
          state.queue = [];
          root.querySelector(".photo-days").replaceChildren();
          state.next = "";
          state.month = date.month;
          root.closest(".page").scrollTop = 0;
          for (const item of rail.children)
            item.removeAttribute("aria-current");
          button.setAttribute("aria-current", "date");
          state.load();
        };
        rail.append(button);
      }
    }
  }
  state.load = async () => {
    if (!current() || state.loading || state.refreshing || state.next === null)
      return;
    state.loading = true;
    const more = root.querySelector(".photo-more");
    more.disabled = true;
    more.innerHTML = busyIcon();
    more.setAttribute("aria-label", "Loading gallery");
    more.setAttribute("aria-busy", "true");
    try {
      const data = await galleryPage(
        "/v1/gallery?" +
          new URLSearchParams({
            volume,
            after: state.next,
            month: state.month,
          }),
      );
      if (!current()) return;
      if (data.indexing) {
        state.indexing = true;
        if (!state.items.length) addItems(data.items);
        more.innerHTML = busyIcon();
        more.setAttribute("aria-label", "Preparing gallery");
        setTimeout(() => {
          state.loading = false;
          state.load();
        }, 250);
        return;
      }
      if (state.indexing) {
        state.indexing = false;
        state.observer?.disconnect();
        state.items = [];
        state.paths.clear();
        state.queue = [];
        root.querySelector(".photo-days").replaceChildren();
        root.querySelector(".photo-timeline").replaceChildren();
      }
      updateTimeline(data);
      addItems(data.items);
      state.next = data.next;
      more.hidden = !data.next;
      more.textContent = "Load more";
      more.removeAttribute("aria-label");
      if (!state.items.length)
        root.querySelector(".photo-days").innerHTML = empty(
          "No photos yet",
          "Photos uploaded to this folder will appear here.",
          "",
          "images",
        );
    } catch {
      if (current()) {
        more.textContent = "Could not load gallery. Retry";
        more.removeAttribute("aria-label");
      }
    } finally {
      if (current()) {
        state.loading = false;
        more.disabled = false;
        more.removeAttribute("aria-busy");
      }
    }
  };
  // Refresh the loaded range without remounting the page or disturbing a viewer.
  const refreshGallery = async () => {
    if (
      !current() ||
      document.hidden ||
      state.loading ||
      state.refreshing ||
      $("#dialog").open ||
      state.selection.size
    )
      return;
    state.refreshing = true;
    const month = state.month;
    try {
      const items = [];
      let after = "",
        data;
      const pages = Math.max(1, Math.ceil(state.items.length / 60));
      for (let page = 0; page < pages; page++) {
        data = await galleryPage(
          "/v1/gallery?" + new URLSearchParams({ volume, month, after }),
          true,
        );
        if (
          !current() ||
          state.loading ||
          state.month !== month ||
          $("#dialog").open ||
          state.selection.size ||
          data.indexing
        )
          return;
        items.push(...data.items);
        after = data.next;
        if (!after) break;
      }
      if (JSON.stringify(items) === JSON.stringify(state.items)) return;
      const page = root.closest(".page");
      const top = page.getBoundingClientRect().top;
      const anchor = [...root.querySelectorAll(".photo-thumb")].find(
        (tile) => tile.getBoundingClientRect().bottom > top,
      );
      const anchorPath =
        anchor && state.items[Number(anchor.dataset.photo)]?.path;
      const offset = anchor?.getBoundingClientRect().top;
      stopHover();
      state.observer?.disconnect();
      state.ratios = new Map(
        [...root.querySelectorAll(".photo-thumb")].map((tile) => [
          state.items[Number(tile.dataset.photo)]?.path,
          tile.photoRatio,
        ]),
      );
      state.items = [];
      state.paths.clear();
      state.queue = [];
      root.querySelector(".photo-days").replaceChildren();
      root.querySelector(".photo-timeline").replaceChildren();
      updateTimeline(data);
      addItems(items);
      state.next = after;
      root.querySelector(".photo-more").hidden = !after;
      const index = state.items.findIndex((item) => item.path === anchorPath);
      const nextAnchor = root.querySelector(`[data-photo="${index}"]`);
      if (nextAnchor && offset != null)
        page.scrollTop += nextAnchor.getBoundingClientRect().top - offset;
    } catch {
      /* Keep the visible gallery during temporary disconnection. */
    } finally {
      state.refreshing = false;
    }
  };
  const refreshTimer = setInterval(refreshGallery, 5000);
  document.addEventListener("visibilitychange", refreshGallery);
  document.addEventListener("arca-changes", refreshGallery);
  root.querySelector(".photo-more").onclick = state.load;
  state.moreObserver =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) state.load();
          },
          { rootMargin: "400px" },
        )
      : null;
  state.moreObserver?.observe(root.querySelector(".photo-more"));
  const page = root.closest(".page");
  const rail = root.querySelector(".photo-timeline");
  const sizeTimeline = () => {
    if (!current()) return;
    const bounds = page.getBoundingClientRect();
    const top = Math.max(bounds.top, root.getBoundingClientRect().top);
    const bottom = parseFloat(getComputedStyle(page).paddingBottom) || 0;
    if (state.layoutWidth !== root.clientWidth) {
      state.layoutWidth = root.clientWidth;
      layoutPhotos();
    }
    rail.style.setProperty(
      "--timeline-height",
      `${Math.max(120, bounds.bottom - top - bottom)}px`,
    );
  };
  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(sizeTimeline)
      : null;
  resizeObserver?.observe(page);
  window.addEventListener("resize", sizeTimeline);
  state.cleanup = () => {
    clearInterval(refreshTimer);
    document.removeEventListener("visibilitychange", refreshGallery);
    document.removeEventListener("arca-changes", refreshGallery);
    stopHover();
    document.removeEventListener("visibilitychange", hideHover);
    resizeObserver?.disconnect();
    window.removeEventListener("resize", sizeTimeline);
    page.removeEventListener("scroll", state.onScroll);
  };
  state.onScroll = () => {
    stopHover();
    if (!current()) {
      page.removeEventListener("scroll", state.onScroll);
      return;
    }
    sizeTimeline();
    const top = page.getBoundingClientRect().top;
    const groups = [...root.querySelectorAll(".photo-day")];
    const active = groups.find(
      (group) => group.getBoundingClientRect().bottom > top + 80,
    );
    if (active)
      for (const button of root.querySelectorAll(".photo-timeline button")) {
        if (button.dataset.month === active.dataset.day.slice(0, 7))
          button.setAttribute("aria-current", "date");
        else button.removeAttribute("aria-current");
      }
  };
  page.addEventListener("scroll", state.onScroll, { passive: true });
  sizeTimeline();
  state.load();
}
function galleryCanDelete() {
  return (
    status.role !== "backup" &&
    (status.role === "hub" ||
      status.volumes.find((v) => v.id === galleryView?.volume)?.selected)
  );
}
function deleteGalleryPhotos(items) {
  if (!items.length || !galleryCanDelete()) return;
  const state = galleryView;
  const inViewer = $("#dialog").classList.contains("photo-viewer");
  const remaining = [...items];
  let completed = 0;
  modal(
    modalHeader(
      `Delete ${items.length === 1 ? "this photo" : `${items.length} photos`}?`,
      "Deletes from synced folders. Originals in a phone’s system gallery are kept. Recovery depends on this folder’s revision retention.",
      "trash-2",
    ),
    async () => {
      try {
        for (const item of [...remaining]) {
          await api("/v1/delete-file", {
            volume: state.volume,
            path: item.path,
            rev: item.rev,
          });
          state.removePhoto(item);
          completed++;
          remaining.shift();
        }
      } catch (error) {
        state.updateSelection();
        throw new Error(
          `${completed} of ${items.length} deleted. ${error.message}`,
        );
      }
      notice(`${completed} ${completed === 1 ? "photo" : "photos"} deleted.`);
      if (inViewer)
        return async () => {
          const next = state.items.findIndex(
            (item, index) => index > state.selected && !item.deleted,
          );
          const previous = state.items.findLastIndex((item) => !item.deleted);
          if (next >= 0 || previous >= 0)
            await openGalleryPhoto(next >= 0 ? next : previous);
          else $("#dialog").close();
        };
      // The current grid is already updated; do not replace it with a stale
      // replica catalog while the background synchronization catches up.
      return () => {};
    },
    "Delete",
    false,
    inViewer,
  );
  $("#submit-dialog").className = "secondary danger";
}
async function downloadGalleryPhoto(item) {
  if (native) {
    await invoke("save_file", { volume: galleryView.volume, path: item.path });
  } else {
    const link = document.createElement("a");
    link.href =
      "/v1/gallery/download?" +
      new URLSearchParams({
        volume: galleryView.volume,
        path: item.path,
        hash: item.hash,
      });
    link.download = item.path.split("/").pop();
    document.body.append(link);
    link.click();
    link.remove();
  }
}
function galleryPhotoDate(item) {
  const value = item.date || item.captured;
  if (!value) return "Unavailable";
  const date = new Date(
    value.length === 7
      ? `${value}-01T12:00:00`
      : value.length === 10
        ? `${value}T12:00:00`
        : value,
  );
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en", {
    year: "numeric",
    month: "long",
    ...(value.length > 7 ? { day: "numeric" } : {}),
    ...(value.length > 10 ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}
// Keep only a small window of decoded previews; share work between navigation and prefetch.
async function galleryPreview(state, item) {
  state.previews ||= new Map();
  state.previewRequests ||= new Map();
  const key = item.hash;
  if (state.previews.has(key)) return state.previews.get(key);
  if (state.previewRequests.has(key)) return state.previewRequests.get(key);
  const request = Promise.resolve()
    .catch(() => {})
    .then(async () => {
      if (galleryView !== state || !state.root.isConnected || item.deleted)
        return {};
      const active = state.items[state.selected];
      const position = state.items.indexOf(item);
      if (item !== active && Math.abs(position - state.selected) > 1) return {};
      const result = await cachedPhoto(state.previewRoute(item, true));
      if (result.data) {
        const image = new Image();
        image.src = result.data;
        if (image.decode) await image.decode();
        if (galleryView !== state || !state.root.isConnected || item.deleted)
          return {};
        state.previews.set(key, { data: result.data, image });
        let total = [...state.previews.values()].reduce(
          (sum, value) => sum + value.data.length,
          0,
        );
        while (
          state.previews.size > 3 ||
          (total > 24 * 1024 ** 2 && state.previews.size > 1)
        ) {
          const oldest = state.previews.keys().next().value;
          total -= state.previews.get(oldest).data.length;
          state.previews.delete(oldest);
        }
        return state.previews.get(key);
      }
      return result;
    });
  state.previewRequests.set(key, request);
  try {
    return await request;
  } finally {
    state.previewRequests.delete(key);
  }
}
function galleryInfo(item, volume, meta = {}) {
  const row = (label, value, symbol, detail = "", extra = "") =>
    value || detail
      ? `<div class="photo-info-row">${icon(symbol)}<div><dt>${label}</dt><dd>${escape(value)}${detail ? `<span class="hint">${escape(detail)}</span>` : ""}${extra}</dd></div></div>`
      : "";
  const number = (value) => Number(value.toFixed(2)).toString();
  const dimensions =
    meta.width && meta.height
      ? `${meta.width} × ${meta.height} · ${number((meta.width * meta.height) / 1000000)} MP`
      : "";
  const camera = meta.model?.toLowerCase().startsWith(meta.make?.toLowerCase())
    ? meta.model
    : [meta.make, meta.model].filter(Boolean).join(" ");
  const metrics = [
    ["Aperture", meta.aperture && `f/${number(meta.aperture)}`],
    [
      "Shutter",
      meta.exposure &&
        (meta.exposure < 1
          ? `1/${Math.round(1 / meta.exposure)} s`
          : `${number(meta.exposure)} s`),
    ],
    ["ISO", meta.iso],
    ["Focal", meta.focalLength && `${number(meta.focalLength)} mm`],
  ].filter(([, value]) => value);
  const date = meta.captured
    ? galleryPhotoDate({ date: meta.captured })
    : galleryPhotoDate(item);
  const coordinates = meta.location
    ? `${meta.location.latitude.toFixed(6)}, ${meta.location.longitude.toFixed(6)}`
    : "";
  const map = coordinates
    ? `<a class="photo-map" href="https://maps.google.com/?q=${encodeURIComponent(coordinates)}" target="_blank" rel="noopener noreferrer">Open in Maps ${icon("arrow-up-right")}</a>`
    : "";
  return `<div class="photo-info-summary"><p class="mono">${escape(item.path.split("/").pop())}</p><p class="hint">${escape([bytes(item.size), dimensions, meta.format].filter(Boolean).join(" · "))}</p></div>
    <section class="photo-info-section"><h3 class="section-label">Capture</h3><dl>
    ${row(meta.captured ? "Taken" : item.dateSource === "date added" ? "Date added" : "Date", date, "calendar", meta.offset ? `UTC${meta.offset}` : "")}
    ${row("Camera", camera, "camera", meta.lens || "")}</dl>
    ${metrics.length ? `<dl class="photo-capture-stats">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd class="mono">${escape(String(value))}</dd></div>`).join("")}</dl>` : ""}
    <dl>${row("Location", coordinates, "map-pin", "", map)}</dl></section>
    <section class="photo-info-section"><h3 class="section-label">In Arca</h3><dl>${row("File path", (status.volumes.find((v) => v.id === volume)?.name || "") + "/" + item.path, "folder")}
    ${meta.accepted ? row("Accepted by hub", galleryPhotoDate({ date: meta.accepted.date }), "upload", `${meta.accepted.machine ? `From ${meta.accepted.machine} · ` : ""}rev ${meta.accepted.revision}`) : ""}</dl></section>`;
}
async function openGalleryPhoto(index) {
  const state = galleryView,
    item = state?.items[index];
  if (!item || item.deleted) return;
  state.stopHover?.();
  state.stopMedia?.();
  const previousIndex = state.items.findLastIndex(
    (photo, i) => i < index && !photo.deleted,
  );
  const nextIndex = state.items.findIndex(
    (photo, i) => i > index && !photo.deleted,
  );
  const focusNext = document.activeElement?.classList.contains("photo-next");
  const focusPrevious =
    document.activeElement?.classList.contains("photo-previous");
  state.selected = index;
  modal(
    `<div class="photo-viewer-head"><h2 id="dialog-title" class="sr-only">${escape(item.path.split("/").pop())}</h2><div class="photo-viewer-operations"><button type="button" class="icon-button photo-download" aria-label="Download photo" title="Download">${icon("download")}</button><button type="button" class="icon-button photo-info-toggle" aria-label="Photo information" aria-expanded="false" title="Info">${icon("info")}</button>${galleryCanDelete() ? `<button type="button" class="icon-button photo-delete" aria-label="Delete photo" title="Delete">${icon("trash-2")}</button>` : ""}</div></div><div class="photo-viewer-stage"><div class="photo-viewer-image" aria-live="polite">${busyIcon()}</div><button type="button" class="icon-button photo-previous" aria-label="Previous photo" ${previousIndex < 0 ? "disabled" : ""}>${icon("chevron-left")}</button><button type="button" class="icon-button photo-next" aria-label="Next photo" ${nextIndex < 0 ? "disabled" : ""}>${icon("chevron-right")}</button></div><aside class="photo-info" hidden><header><h2>Info</h2><button type="button" class="icon-button photo-info-close" aria-label="Close information">${icon("x")}</button></header><div class="photo-info-body">${item.metadata ? galleryInfo(item, state.volume, item.metadata) : scaffoldInfo(item)}</div><footer class="photo-info-footer" hidden><button type="button" class="secondary photo-file" hidden>${icon("history")}File history</button>${native && status.volumes.find((v) => v.id === state.volume)?.path ? `<button type="button" class="secondary icon-button photo-reveal" aria-label="Show in folder" title="Show in folder">${icon("folder-open")}</button>` : ""}</footer></aside>`,
    null,
    "",
    true,
  );
  $("#dialog").className = "photo-viewer";
  $("#submit-dialog").hidden = true;
  $("#cancel-dialog").innerHTML = icon("arrow-left");
  $("#cancel-dialog").setAttribute("aria-label", "Back to gallery");
  $(".photo-download").onclick = () => action(() => downloadGalleryPhoto(item));
  $(".photo-delete")?.addEventListener("click", () =>
    deleteGalleryPhotos([item]),
  );
  const infoPanel = $(".photo-info");
  const updateInfoActions = () => {
    infoPanel.querySelector(".photo-file").hidden = !item.metadata?.hasHistory;
    infoPanel.querySelector(".photo-info-footer").hidden =
      !item.metadata?.hasHistory && !infoPanel.querySelector(".photo-reveal");
    const map = infoPanel.querySelector(".photo-map");
    if (native && map)
      map.onclick = (event) => {
        event.preventDefault();
        action(() => invoke("open_maps", item.metadata.location));
      };
  };
  updateInfoActions();
  infoPanel.querySelector(".photo-reveal")?.addEventListener("click", () =>
    action(() =>
      status.platform === "darwin"
        ? invoke("open_file", {
            volume: state.volume,
            path: item.path,
            reveal: true,
          })
        : invoke("open_folder", { id: state.volume }),
    ),
  );
  let infoLoading = false;
  const loadInfo = async () => {
    if (item.metadata || infoLoading) return;
    infoLoading = true;
    try {
      const metadata = await api(
        "/v1/gallery/info?" +
          new URLSearchParams({
            volume: state.volume,
            path: item.path,
            hash: item.hash,
          }),
      );
      item.metadata = metadata;
      if (infoPanel.isConnected) {
        infoPanel.querySelector(".photo-info-body").innerHTML = galleryInfo(
          item,
          state.volume,
          metadata,
        );
        updateInfoActions();
        icons();
      }
    } catch {
      if (infoPanel.isConnected)
        infoPanel.querySelector(".photo-info-body").innerHTML = galleryInfo(
          item,
          state.volume,
        );
      if (
        infoPanel.isConnected &&
        !infoPanel.querySelector(".photo-info-error")
      )
        infoPanel.insertAdjacentHTML(
          "beforeend",
          '<p class="photo-info-error hint" role="status">Photo metadata could not be loaded. Close and reopen Info to retry.</p>',
        );
    } finally {
      infoLoading = false;
    }
  };
  let panelAnimation = null;
  let infoExpanded = false;
  const toggleInfo = (open) => {
    if (open === infoExpanded) return;
    infoExpanded = open;
    panelAnimation?.cancel();
    panelAnimation = null;
    if (open) {
      infoPanel.querySelector(".photo-info-error")?.remove();
      loadInfo();
    }
    infoPanel.hidden = false;
    infoPanel.inert = !open;
    infoPanel.setAttribute("aria-hidden", String(!open));
    $("#dialog").classList.toggle("photo-info-open", open);
    $(".photo-info-toggle").setAttribute("aria-expanded", String(open));
    if (!open && infoPanel.contains(document.activeElement))
      $(".photo-info-toggle").focus();
    const frames = [
      { opacity: 0, transform: "translateX(24px)" },
      { opacity: 1, transform: "translateX(0)" },
    ];
    panelAnimation = infoPanel.animate?.(
      open ? frames : [...frames].reverse(),
      {
        duration: motionDuration(open ? "--motion-enter" : "--motion-exit"),
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    );
    if (panelAnimation)
      panelAnimation.onfinish = () => {
        infoPanel.hidden = !infoExpanded;
      };
    else infoPanel.hidden = !open;
  };
  $(".photo-info-toggle").setAttribute("aria-keyshortcuts", "Meta+i Control+i");
  $(".photo-info-toggle").title = "Info (⌘I / Ctrl+I)";
  $(".photo-info-toggle").onclick = () => toggleInfo(!infoExpanded);
  $(".photo-info-close").onclick = () => toggleInfo(false);
  toggleInfo(false);
  $(".photo-previous").onclick = () => openGalleryPhoto(previousIndex);
  $(".photo-next").onclick = () => openGalleryPhoto(nextIndex);
  $(".photo-file").onclick = () => {
    $("#dialog").close();
    action(() =>
      handle(
        "activity-file",
        JSON.stringify({
          volume: state.volume,
          path: item.path,
          rev: item.rev,
        }),
      ),
    );
  };
  const navigationFocus = focusNext
    ? $(".photo-next")
    : focusPrevious
      ? $(".photo-previous")
      : null;
  (navigationFocus && !navigationFocus.disabled
    ? navigationFocus
    : $("#cancel-dialog")
  ).focus();
  const target = $(".photo-viewer-image");
  if (item.kind === "image") {
    const available =
      state.previews?.get(item.hash)?.image ||
      state.root.querySelector(`[data-photo="${index}"] .photo-open img`);
    if (available) {
      const image = available.cloneNode();
      image.className = "photo-preview-placeholder";
      image.alt = item.path.split("/").pop();
      target.replaceChildren(image);
    }
  }
  try {
    if (item.kind === "video") {
      const playback = await api(
        "/v1/gallery/playback?" +
          new URLSearchParams({
            volume: state.volume,
            path: item.path,
            hash: item.hash,
          }),
      );
      if (!target.isConnected || !$("#dialog").open) return;
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.setAttribute("aria-label", item.path.split("/").pop());
      cachedPhoto(
        "/v1/gallery/preview?" +
          new URLSearchParams({
            volume: state.volume,
            path: item.path,
            hash: item.hash,
          }),
      )
        .then((poster) => {
          if (video.isConnected && poster.data) video.poster = poster.data;
        })
        .catch(() => {});
      video.src = playback.url;
      video.onerror = () => {
        if (target.isConnected)
          target.insertAdjacentHTML(
            "beforeend",
            '<p class="video-error" role="status">This video format cannot play in this browser. Download the original to open it.</p>',
          );
      };
      target.replaceChildren(video);
      const stop = () => {
        if (state.stopMedia === stop) state.stopMedia = null;
        $("#dialog").removeEventListener("close", stop);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
      state.stopMedia = stop;
      $("#dialog").addEventListener("close", stop, { once: true });
      video.play().catch(() => {}); // Native controls remain available if autoplay is blocked.
      return;
    }
    const pending = galleryPreview(state, item);
    for (const neighbor of [nextIndex, previousIndex]) {
      const photo = state.items[neighbor];
      if (photo?.kind === "image")
        void galleryPreview(state, photo).catch(() => {});
    }
    const result = await pending;
    if (!target.isConnected || !$("#dialog").open) return;
    if (result.data) {
      const img = result.image || document.createElement("img");
      if (!result.image) img.src = result.data;
      img.alt = item.path.split("/").pop();
      target.replaceChildren(img);
    } else if (!target.querySelector("img"))
      target.innerHTML = `<div>${icon(item.kind === "video" ? "play" : "image-off")}<p>${item.kind === "video" ? "Open the file to play this video." : "Preview unavailable. The original file is preserved."}</p></div>`;
  } catch {
    if (target.isConnected && !target.querySelector("img"))
      target.textContent = "Preview unavailable. Try opening the file.";
  }
  icons();
}
document.addEventListener("keydown", (event) => {
  if (!$("#dialog").open || !$("#dialog").classList.contains("photo-viewer"))
    return;
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "i" &&
    !event.target.closest?.("input, textarea, select, [contenteditable]")
  ) {
    event.preventDefault();
    if (!event.repeat) $(".photo-info-toggle")?.click();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    $(event.key === "ArrowLeft" ? ".photo-previous" : ".photo-next")?.click();
  }
});

function galleryModeButton(volume) {
  if (!volume.gallery)
    return status.role === "hub" || volume.selected
      ? button(
          "Enable gallery",
          "enable-gallery",
          volume.id,
          "secondary",
          "images",
        )
      : "";
  return button(
    folderTab === "gallery" ? "Exit gallery" : "Gallery",
    "gallery-mode",
    volume.id,
    "primary gallery-mode-toggle",
    folderTab === "gallery" ? "layout-list" : "images",
  );
}
async function folderBrowser(v, recent, pending = false) {
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
  )}<div>${folderTab === "files" ? `<button class="icon-button" data-action="folder-search-toggle" aria-label="${folderSearchOpen ? "Close search" : "Search files"}">${icon(folderSearchOpen ? "x" : "search")}</button>` : folderTab === "recent" ? button("All history", "folder-history", v.id, "text-button") : ""}</div></div>`;
  if (folderTab === "gallery")
    return `<div id="photo-selection" class="photo-selection-bar" hidden><button type="button" class="icon-button photo-selection-clear" aria-label="Clear selection">${icon("x")}</button><strong class="photo-selection-count" role="status"></strong><button type="button" class="secondary danger photo-selection-delete">${icon("trash-2")}Delete selected…</button>${galleryModeButton(v)}</div><div id="photo-gallery"><div class="photo-days"></div><nav class="photo-timeline" aria-label="Photo dates"></nav><button type="button" class="secondary photo-more" aria-label="Loading gallery" aria-busy="true" disabled>${busyIcon()}</button></div>`;
  if (pending && folderTab === "recent" && !recent)
    return tools + scaffoldRow("history");
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
    const data = await readFolderPage(
      "/v1/browse?" +
        new URLSearchParams({
          volume: v.id,
          prefix: folderPrefix,
          search: folderSearch,
          after: folderAfter,
          limit: "100",
        }),
      pending,
    );
    if (!data) return tools + scaffoldRow("history");
    return (
      tools +
      search +
      `<div class="history-group folder-explorer">${trail}` +
      (data.entries.length
        ? `${data.entries.map((row) => `<div class="browser-file-row" role="button" tabindex="0" data-action="${row.directory ? "browse-directory" : "activity-file"}" data-id="${escape(row.directory ? row.path : JSON.stringify({ volume: v.id, path: row.path, rev: row.rev }))}" aria-label="${escape(`Open ${row.name}`)}">${icon(fileIcon(row.path, row.directory))}<div><strong>${escape(row.name)}</strong><p>${row.directory ? `${row.files} ${row.files === 1 ? "file" : "files"} · ` : ""}${bytes(row.size)}</p></div>${icon("chevron-right")}</div>`).join("")}`
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

async function renderDetail(pending = false) {
  const serial = renderSerial;
  const v = status.volumes.find((v) => v.id === detailId);
  if (!v) {
    detailId = null;
    return render();
  }
  if (folderViewId !== v.id) {
    folderViewId = v.id;
    folderTab = v.gallery ? "gallery" : "files";
    folderReturn = { tab: "files", scroll: 0 };
  }
  if (folderTab === "gallery") {
    // The photo grid does not depend on activity, file browsing or copy reports.
    $("#content").innerHTML =
      `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}${title(escape(v.name), `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)}`, galleryModeButton(v))}</div><div class="page detail-page gallery-page">${await folderBrowser(v, [])}</div>`;
    $("#content").dataset.detail = v.id;
    icons();
    mountGallery(v.id);
    return;
  }
  if (status.role !== "hub" && !status.hub) {
    $("#content").innerHTML =
      `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}${title(escape(v.name), `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)} local`, (native && v.path && folderTab !== "gallery" ? button(status.platform === "darwin" ? "Open in Finder" : "Open folder", "open", v.id, "secondary", "external-link") : "") + galleryModeButton(v))}</div><div class="page detail-page ${folderTab === "gallery" ? "gallery-page" : ""}">${folderTab === "gallery" ? "" : section("Hub connection", hubConnection()) + `<div class="stats">${folderRetentionSummary(v)}</div>`}${await folderBrowser(v, [])}</div>`;
    icons();
    if (folderTab === "gallery") mountGallery(v.id);
    return;
  }
  if (!pending && $("#content").dataset.detail !== detailId)
    await renderDetail(true);
  const recentRoute = `/v1/activity?volume=${encodeURIComponent(v.id)}&limit=4`;
  let recent = knownFolderPage(recentRoute)?.versions;
  try {
    recent = (await readFolderPage(recentRoute, pending))?.versions || recent;
  } catch {}
  if (!pending && !recent) recent = [];
  if (view !== "folders" || detailId !== v.id || serial !== renderSerial)
    return;
  const browser = await folderBrowser(v, recent, pending);
  if (serial !== renderSerial || view !== "folders" || detailId !== v.id)
    return;
  const state = stateFor(v);
  const maxRev = recent?.[0]?.rev;
  const unscanned =
    !Number.isFinite(v.files) ||
    (v.sync?.state === "error" && !v.sync.lastCompleted);
  $("#content").innerHTML =
    `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}<div class="heading"><div class="detail-title"><div class="tile large">${icon(v.gallery ? "images" : "folder")}</div><div><h1>${escape(v.name)}</h1><p>${unscanned ? "Not counted yet" : `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)} ${v.path ? "local" : "on hub"}`}</p></div></div><div class="heading-actions">${status.role === "hub" ? button("Rename", "rename-share", v.id, "secondary", "pencil") + (v.selected ? button(".arcaignore…", "edit-ignore", v.id, "secondary", "file-pen-line") : "") : ""}${native && v.path && folderTab !== "gallery" ? button(status.platform === "darwin" ? "Open in Finder" : "Open folder", "open", v.id, "secondary", "external-link") : ""}${galleryModeButton(v)}</div></div></div><div class="page detail-page ${folderTab === "gallery" ? "gallery-page" : ""}"><div class="stats folder-stats"><div class="stat"><span>Status</span><strong class="stat-status ${state[1]}">${state[2] === "busy" ? busyIcon() : icon(state[2])}${escape(state[0])}</strong><p>${v.sync?.lastCompleted ? `Completed ${relative(v.sync.lastCompleted)}` : "No completed sync yet"}</p></div><div class="stat"><span>Files</span><strong>${unscanned ? "Not counted" : v.files.toLocaleString("en")}</strong><p>${unscanned ? (v.policyError ? "Resolve the exclusion policy error" : "Waiting for the first scan") : `${bytes(v.bytes)} indexed`}</p></div><div class="stat"><span>Latest known revision</span><strong class="mono">${maxRev ? `rev ${maxRev}` : pending && !recent ? scaffoldLine("short") : "Not yet"}</strong><p>Accepted by the hub</p></div>${folderRetentionSummary(v)}</div><div class="detail-grid"><div class="detail-revisions">${browser}</div><div class="detail-side">${section(status.role === "hub" ? `Path on ${escape(status.name)}` : "Local destination", `<div class="panel"><p class="path">${escape(v.path || "No visible copy selected")}</p>${native && status.role !== "hub" && v.path ? button("Change location…", "move-folder", v.id, "secondary small-button", "folder-input") : ""}</div>`)}${section("Copies", '<div class="copies-card" id="folder-copies"></div>')}<div class="panel"><h3>${status.role === "hub" ? "Hub working copy" : `Stop syncing on ${machineLabel()}`}</h3><p>${status.role === "hub" ? "Controls this hub’s folder on disk. Disabling it keeps the shared folder and history available to replicas; files remain on disk." : "Stops syncing this folder here. Files stay on disk and history is retained."}</p>${button(v.selected ? (status.role === "hub" ? "Disable local sync…" : "Unlink…") : "Select…", v.selected ? "unselect" : "add", v.id, v.selected ? "secondary danger" : "secondary", v.selected ? "unlink" : "download")}</div>${status.role === "hub" ? `<div class="panel"><h3>Delete shared folder</h3><p>Stops sharing on all machines and deletes this shared folder’s history from the hub. Physical files and existing backups are kept.</p>${button("Delete shared folder…", "delete-share", v.id, "secondary danger", "trash-2")}</div>` : ""}</div></div></div>`;
  $("#content").dataset.detail = v.id;
  refreshCopies();
  if (!pending && folderTab === "gallery") mountGallery(v.id);
}
async function renderHistory(
  cursor = "",
  append = false,
  target = null,
  cached = false,
) {
  const serial = renderSerial;
  const key = JSON.stringify([
    status.id,
    status.hubId,
    status.hub,
    historyVolume,
    historyPath,
    historyFilter,
  ]);
  async function readHistory(route) {
    if (cached) return historyCache.get(key);
    const data = await viewRead(route);
    if (serial !== renderSerial) return null;
    if (!cursor && !append) {
      historyCache.delete(key);
      historyCache.set(key, data);
      if (historyCache.size > 20)
        historyCache.delete(historyCache.keys().next().value);
    }
    return data;
  }
  if (view === "history" && location.hash !== routeURL())
    window.history.pushState(null, "", routeURL());
  let list = target || $("#history-list");
  if (!list) return;
  if (historyPath) {
    const data = await readHistory(
      `/v1/history?volume=${encodeURIComponent(historyVolume)}&path=${encodeURIComponent(historyPath)}&limit=50${cursor ? `&before=${cursor}` : ""}`,
    );
    if (!data) {
      if (cached) {
        historyVersions = [];
        list.innerHTML = section("File revisions", scaffoldRow("history"));
      }
      return;
    }
    if (!target) list = $("#history-list");
    if (!list) return;
    historyVersions = append
      ? [...historyVersions, ...data.versions]
      : data.versions;
    if (data.localOnly) {
      list.innerHTML = section("File revisions", '<p class="hint">History is unavailable while the hub is offline. Your local file is still available.</p>');
      return;
    }
    list.innerHTML =
      (data.offline ? '<p class="hint">Offline · showing saved history</p>' : "") +
      section(
        "File revisions",
        historyVersions.length
          ? `<div class="history-group">${historyVersions.map((v, index) => `<div class="history-row file-version-row">${icon(v.deleted ? "trash-2" : "git-commit-horizontal")}<div><strong>${date(v.created)}</strong><p>${v.deleted ? "Deleted file" : bytes(v.size)} · ${escape(authorName(v.author))}</p></div><span class="mono revision">rev ${v.rev}</span><div class="row-actions">${index === 0 ? pill("Current", "id", "check") : v.deleted ? "" : button("Restore", "restore", String(v.rev), "text-button", "undo-2")}</div></div>`).join("")}</div>`
          : empty(
              "No retained revisions",
              "This file has no history available on the hub.",
            ),
      ) +
      `${data.next ? `<div class="pagination">${button("Load more", "history-page", data.next)}</div>` : ""}`;
    icons();
    return;
  }
  const data = await readHistory(
    `/v1/activity?limit=50&filter=${historyFilter}${historyVolume ? `&volume=${encodeURIComponent(historyVolume)}` : ""}${cursor ? `&before=${cursor}` : ""}`,
  );
  if (!data) {
    if (cached) list.innerHTML = section("Loading", scaffoldRow("history"));
    return;
  }
  if (!target) list = $("#history-list");
  if (!list) return;
  if (data.offline && !data.versions.length) {
    list.innerHTML = empty("History unavailable offline", "Your local files remain available. Connect to the hub to load their history.");
    return;
  }
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
  list.innerHTML = (data.offline ? '<p class="hint">Showing saved history · recent entries only. Connect to the hub for updated retention and older revisions.</p>' : "") + (historyRows.length
    ? [...groups]
        .map(([day, rows]) =>
          section(
            day,
            `<div class="history-group">${rows.map((v) => revisionRow(v)).join("")}</div>`,
          ),
        )
        .join("") +
      `${historyNext ? `<div class="pagination">${button("Load more", "history-page", historyNext)}</div>` : ""}`
    : empty("Every change has a history", "Changes to your files appear here."));
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

async function renderMachines(serial = renderSerial, fetchData = true) {
  let issue = "";
  if (fetchData) {
    const [discoveryResult, rosterResult] = await Promise.allSettled([
      viewRead("/v1/discovery"),
      viewRead("/v1/machines"),
    ]);
    if (view !== "devices" || serial !== renderSerial) return;
    if (discoveryResult.status === "fulfilled")
      discovered = discoveryResult.value;
    else issue = discoveryResult.reason.message;
    if (rosterResult.status === "fulfilled") roster = rosterResult.value;
    else issue ||= rosterResult.reason.message;
    if (issue)
      notice(issue, true, {
        id: "view:devices",
        action: "refresh",
        actionLabel: "Retry now",
      });
    else noticeStore.clear("view:devices");
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
  const summary = roster?.offline ? '<p class="hint">Offline · showing saved machine information</p>' : "";
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
          : `<details class="details-menu"><summary class="icon-button" aria-label="Actions for ${escape(d.name)}">${icon("ellipsis")}</summary><div class="menu-items">${button(status.webApprovers?.includes(d.id) ? "Disable web approval" : "Allow web approval…", "web-approver", d.id, "secondary", "shield-check")}${button("Disconnect", "revoke", d.id, "secondary danger", "unplug")}</div></details>`,
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
        : !fetchData
          ? scaffoldRow()
          : empty(
              "Machine list unavailable",
              "Reconnect to the hub to see its machines.",
            );
  }
  html += section("Machines", machineRows);
  if (!fetchData && !discovered)
    html += section("Discovery", scaffoldRow("card", true));
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
async function renderSettings(fetchData = true, serial = renderSerial) {
  const interaction = statusRequestSerial;
  if (
    !fetchData &&
    $("#content").contains(document.activeElement) &&
    document.activeElement.matches("input,textarea,select")
  )
    return;
  if (fetchData) {
    try {
      const next = await viewRead("/v1/network");
      if (view !== "settings" || serial !== renderSerial) return;
      network = next;
      noticeStore.clear("view:settings");
    } catch (error) {
      if (view !== "settings" || serial !== renderSerial) return;
      notice(error.message, true, {
        id: "view:settings",
        action: "refresh",
        actionLabel: "Retry now",
      });
    }
    if (interaction !== statusRequestSerial || $("#dialog").open) return;
    // Keep an in-progress edit intact while network information refreshes.
    if (
      $("#content").contains(document.activeElement) &&
      document.activeElement.matches("input,textarea,select")
    )
      return;
  }
  if (view !== "settings" || serial !== renderSerial) return;
  let html = title("Settings", "") + '<div class="page">';
  if (status.role !== "hub") html += section("Hub connection", hubConnection());
  html += section(
    "This machine",
    `<div class="settings-card">${setting("Machine name", "Shown to other machines and in history.", `<input id="machine-name" aria-label="Machine name" maxlength="100" value="${escape(status.name)}">`)}${setting("Default folder location", `<span class="path">${escape(status.root)}</span>`, button("Copy path", "copy", status.root, "secondary small-button", "copy"))}</div>`,
  );
  html += section(
    status.role === "hub" ? "Hub synchronization" : "Local synchronization",
    `<div class="settings-card">${setting(status.role !== "hub" && !status.hub ? "Disconnected" : status.phase === "paused" ? "Paused" : "Enabled", status.role === "hub" ? "Synchronizes this hub’s working folders with connected replicas." : "Synchronizes the folders selected on this machine.", "")}</div>`,
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
      `<div class="settings-card">${setting("Kept", `${status.historyRevisions} accepted revisions. Automatic retention is configured in each folder.`, button("Preview cleanup…", "retention", "", "secondary small-button", "history"))}${setting("Limits", "Preview always precedes applying. Current versions, pending writes and history not yet received by backups are protected.", `<span class="mono">${status.retention.days || 0} days · ${status.retention.versions || 0} versions</span>`)}</div>`,
    );
  if (status.role === "hub")
    html += section(
      "Images",
      '<div id="image-settings" class="image-settings"><p class="hint">Loading gallery library…</p></div>',
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
    )}${setting("Tailscale addresses", `<span class="path">${escape(network?.tailscale?.self?.addresses?.join(" · ") || "No Tailscale address")} · port ${status.port || 17831}</span>`, pill(network?.publishing ? "Discoverable" : "Not advertised", "id", "wifi"))}</div>`,
  );
  if (status.role === "hub")
    html += section(
      "Local network",
      `<div class="settings-card">${setting("Allow HTTP connections", "Pair and sync over your local network without Tailscale. Files and credentials are not encrypted.", toggleControl("allow-lan-http", "Allow HTTP on local network", network?.allowLanHttp === true, network ? "" : "disabled"))}</div>`,
    );
  html += section(
    "Machine discovery",
    `<div class="settings-card">${setting("Find machines on Tailscale", "Look for Arca on connected machines. Finding a machine does not link it.", button("Refresh", "network-refresh", "", "secondary small-button", "refresh-cw"))}</div>`,
  );
  html += section(
    "Service",
    `<div class="settings-card">${setting(`Arca v${APP_VERSION}`, `<span class="mono">node ${escape(status.id)} · protocol v${status.protocol} · ${escape(platformLabel(status.platform))}</span>`, button("Copy diagnostics", "diagnostics", "", "secondary small-button", "copy"))}${setting("Runtime", `<span class="mono">Port ${status.port || 17831} · Node ${escape(status.nodeVersion || "24")}</span>`, "")}${setting("State and index", `<span class="path">${escape(status.statePath || "Not reported")}</span>`, status.statePath ? button("Copy path", "copy", status.statePath, "secondary small-button", "copy") : "")}</div>`,
  );
  if (status.role === "replica" && status.hub)
    html += section(
      "Recovery",
      `<div class="settings-card">${setting("Become the replacement hub", "Requires complete copies of every known shared folder and the old hub stopped.", button("Review…", "promote", "", "secondary small-button"))}${setting("Reconnect to a hub", "Local files remain. Hub backup must be disabled first.", button("Reconnect…", "replacement-hub", "", "secondary small-button", "link"))}</div>`,
    );
  html += section(
    "Appearance",
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
    )}</div>`,
  );
  const destroyRole = status.role === "hub" ? "hub" : "replica";
  html += section(
    "Danger zone",
    `<div class="settings-card replica-danger">${setting(`Destroy this ${destroyRole}`, destroyRole === "hub" ? "Deletes this hub’s folders, history and configuration. Files on replicas are kept." : "Deletes all local folders and resets Arca on this device. Hub files and other machines are kept.", button(`Destroy ${destroyRole}…`, `destroy-${destroyRole}`, "", "primary danger", "trash-2"))}</div>`,
  );
  $("#content").innerHTML = html + "</div>";
  $("#machine-name").onchange = () =>
    action(async () => {
      await api("/v1/settings", { name: $("#machine-name").value });
      await refresh(false);
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
  if (status.role === "hub") void imageLibrary();
}
let imageSettingsRequest = 0;
async function imageLibrary() {
  const root = $("#image-settings");
  if (!root) return;
  const request = ++imageSettingsRequest;
  const active = () =>
    !!window.document &&
    view === "settings" &&
    root.isConnected &&
    request === imageSettingsRequest;
  const update = async () => {
    if (!active()) return;
    try {
      const current = await api("/v1/images");
      if (!active()) return;
      if (!root.querySelector("#image-inventory"))
        root.innerHTML = `
        <div class="settings-card">
          <div id="image-inventory"></div>
          <div class="setting-row image-process-row">
            <div class="row-main"><strong>Previews</strong><div class="image-process-hint">
              <p id="image-regenerate-hint">Refresh photo previews without changing your files.</p>
              <div id="image-regenerate-job" class="image-job" role="status" aria-live="polite" hidden></div>
            </div></div>
            <div id="image-regenerate-control" class="image-process-control"></div>
          </div>
          <div class="setting-row image-process-row">
            <div class="row-main"><strong>Optimize space</strong><div class="image-process-hint">
              <p id="image-convert-hint">${current.encoder.available ? "Save space by converting photos to HEIC. Check potential savings first." : "Photo optimization is unavailable on this hub."}</p>
              <div id="image-convert-job" class="image-job" role="status" aria-live="polite" hidden></div>
            </div></div>
            <div id="image-convert-control" class="image-process-control"></div>
          </div>
        </div>`;
      root.querySelector("#image-inventory").innerHTML =
        current.folders
          .map((folder) =>
            setting(
              escape(folder.name),
              `${folder.photos} ${folder.photos === 1 ? "photo" : "photos"} · ${folder.videos} ${folder.videos === 1 ? "video" : "videos"}`,
              bytes(folder.bytes),
            ),
          )
          .join("") ||
        setting("Gallery library", "No indexed gallery media yet.", "");
      const job = current.job;
      for (const kind of ["regenerate", "convert"]) {
        const target = root.querySelector(`#image-${kind}-job`);
        const selected = job && (job.kind === "regenerate" ? kind === "regenerate" : kind === "convert");
        target.hidden = !selected;
        const hint = root.querySelector(`#image-${kind}-hint`);
        hint.classList.toggle("image-hint-replaced", !!selected);
        hint.setAttribute("aria-hidden", String(!!selected));
        const running = selected && job.state === "running";
        const control = root.querySelector(`#image-${kind}-control`);
        const markup = running
          ? button("Stop process", "images-cancel", "", "secondary small-button", "square")
          : selected && job.confirmation
            ? button("Optimize space…", "images-optimize", job.confirmation, "secondary small-button", "images")
            : kind === "regenerate"
              ? button("Regenerate previews", "images-regenerate", "", "secondary small-button", "refresh-cw")
              : current.encoder.available ? button("Check savings", "images-analyze", "", "secondary small-button", "images") : "";
        if (control.dataset.markup !== markup) {
          control.innerHTML = markup;
          control.dataset.markup = markup;
        }
        const actionButton = control.querySelector("button");
        if (actionButton) actionButton.disabled = job?.state === "running" && !running;
        if (!selected) {
          target.innerHTML = "";
          continue;
        }
        const label = { regenerate: "Refreshing previews", analyze: "Checking savings", optimize: "Optimizing photos" }[job.kind] || "Processing";
        const state = { complete: "Completed", cancelled: "Stopped", failed: "Could not finish. Try again." }[job.state] || label;
        const savings = !running && job.before
          ? ` · ${job.kind === "analyze" ? "Sample savings" : "Photo size reduced"}: ${bytes(job.before - job.after)}`
          : "";
        const summary = `${state} · ${job.done} / ${job.total} processed${savings}`;
        target.innerHTML = `<p class="hint" title="${escape(summary)}">${escape(summary)}</p>
          <progress aria-label="${escape(label)}" value="${Number(job.done) || 0}" max="${Math.max(1, Number(job.total) || 0)}"></progress>`;
      }
      icons();
      if (job?.state === "running") setTimeout(update, 1500);
    } catch (error) {
      if (active())
        root.innerHTML = `<p class="hint">${escape(error.message)}</p>${button("Retry", "images-refresh", "", "secondary small-button", "refresh-cw")}`;
    }
  };
  await update();
}

function modalHeader(heading, description, symbol = "folder") {
  return `<div class="modal-title"><div class="tile">${icon(symbol)}</div><div><h2 id="dialog-title">${heading}</h2><p>${description}</p></div></div>`;
}
const dialogTemplate = $("#dialog").innerHTML;
function modal(html, submit, label = "Save", wide = false, layered = false) {
  if (layered) {
    const previous = $("#dialog"),
      previousSubmit = submitDialog;
    const identified = [previous, ...previous.querySelectorAll("[id]")];
    for (const element of identified) {
      element.dataset.dialogId = element.id;
      element.id = "background-" + element.id;
    }
    const layer = document.createElement("dialog");
    layer.id = "dialog";
    layer.setAttribute("aria-labelledby", "dialog-title");
    layer.innerHTML = dialogTemplate;
    document.body.append(layer);
    layer.restore = () => {
      layer.remove();
      for (const element of identified) {
        element.id = element.dataset.dialogId;
        delete element.dataset.dialogId;
      }
      submitDialog = previousSubmit;
    };
    bindDialog(layer);
  }
  $("#dialog-error").hidden = true;
  $("#dialog-extra-actions")?.remove();
  $("#cancel-dialog").hidden = false;
  $("#dialog-content").onclick = null;
  $("#dialog-content").innerHTML = html;
  $("#dialog").className = wide ? "wide-dialog" : "";
  if (
    !$("#dialog-content").querySelector(
      "input, select, textarea, table, .folder-selection",
    )
  )
    $("#dialog").classList.add("confirmation-dialog");
  $("#submit-dialog").textContent = label;
  $("#submit-dialog").hidden = false;
  $("#submit-dialog").disabled = false;
  $("#submit-dialog").className = "primary";
  $("#cancel-dialog").textContent = "Cancel";
  $("#cancel-dialog").removeAttribute("aria-label");
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
function bindDialog(dialog) {
  const cancel = dialog.querySelector("#cancel-dialog");
  const form = dialog.querySelector("#dialog-form");
  const close = () => {
    dialog.close();
    dialog.restore?.();
  };
  cancel.onclick = () => {
    if (!dialogSubmitting) close();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!dialogSubmitting) close();
  });
  // Dialogs close explicitly; backdrop interaction never discards a draft.
  form.onsubmit = (event) => {
    event.preventDefault();
    const submit = submitDialog;
    const data = new FormData(event.target);
    const control = dialog.querySelector("#submit-dialog");
    // Submission owns this dialog even while waiting behind another mutation.
    dialogSubmitting = true;
    cancel.disabled = true;
    action(async () => {
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
      control.insertAdjacentHTML("afterbegin", busyIcon());
      dialogSubmitting = true;
      cancel.disabled = true;
      try {
        dialog.querySelector("#dialog-error").hidden = true;
        const complete = await submit(data);
        if (complete === false) return;
        close();
        if (typeof complete === "function") await complete();
        else if (ready) void background(() => render({ refreshStatus: true }));
      } finally {
        dialogSubmitting = false;
        control.removeAttribute("aria-busy");
        control.querySelector(".busy-grid")?.remove();
        cancel.disabled = false;
        control.disabled = false;
      }
    }, control);
  };
}
bindDialog($("#dialog"));
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
      catalogLoaded = false;
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
        `http://${ip.includes(":") ? `[${ip}]` : ip}:${status.port || 17831}`,
      );
    const dns = info.tailscale.self?.dnsName?.replace(/\.$/, "");
    if (dns) addresses.push(`http://${dns}:${status.port || 17831}`);
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
      "Choose which version to keep. Both copies remain available in history.",
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
        false,
        { action: "folder-history", actionLabel: "Show", volume: item.volume },
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
  if (name === "install-update") {
    const button = $("#update-install");
    button.disabled = true;
    button.textContent = "Installing…";
    try {
      await invoke("install_update");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Restart and install";
      throw error;
    }
    return;
  }
  if (name === "web-approver") {
    const enabled = !status.webApprovers?.includes(id);
    modal(
      modalHeader(
        enabled ? "Allow web approval?" : "Disable web approval?",
        enabled
          ? "This machine will be able to approve administrator access to this hub’s web interface."
          : "This machine will no longer approve web access.",
        "shield-check",
      ),
      () => api("/v1/web-approvers", { id, enabled }),
      enabled ? "Allow" : "Disable",
    );
    return;
  }
  if (name === "folder-retention") return changeFolderRetention(id, control);
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
      },
      "Rename",
    );
    return;
  }
  if (name === "edit-ignore") {
    const policy = await api(`/v1/ignore-policy?id=${encodeURIComponent(id)}`);
    modal(
      modalHeader(
        ".arcaignore",
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
    const card = control.closest("[data-notice-id]");
    if (card?.dataset.noticeId === "dialog-error")
      $("#dialog-error").hidden = true;
    else if (card) noticeStore.remove(card.dataset.noticeId);
    return;
  }
  if (name === "copy-notice") {
    const text = control
      .closest(".notice-details")
      .querySelector("pre").textContent;
    await navigator.clipboard.writeText(text);
    control.textContent = "Copied";
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
  if (name === "enable-gallery") {
    modal(
      modalHeader(
        "Enable gallery?",
        "Browse this folder’s photos and videos as a gallery. Files and synchronization stay the same.",
        "images",
      ),
      async () => {
        await api("/v1/gallery/link", { volume: id });
        folderTab = "gallery";
      },
      "Enable gallery",
    );
    return;
  }
  if (name === "gallery-mode") {
    const volume = status.volumes.find((v) => v.id === detailId);
    if (!volume?.gallery) return;
    const exiting = folderTab === "gallery";
    if (exiting) folderTab = folderReturn.tab;
    else {
      folderReturn = { tab: folderTab, scroll: $(".page")?.scrollTop || 0 };
      folderTab = "gallery";
    }
    await render();
    if (exiting && $(".page")) $(".page").scrollTop = folderReturn.scroll;
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
  if (name === "folder-problem") {
    const folder = status.volumes.find((item) => item.id === id);
    if (!folder) return;
    modal(
      modalHeader(
        `Synchronization of ${escape(folder.name)} stopped`,
        escape(
          folder.sync?.error ||
            folder.policyError ||
            "No current error reported.",
        ),
        "circle-alert",
      ),
      async () => {
        await api("/v1/sync", { background: true });
        await refresh();
      },
      "Retry now",
    );
    $("#cancel-dialog").textContent = "Close";
    return;
  }
  if (name === "back-folders") {
    detailId = null;
    await render();
    return;
  }
  if (name === "folder-detail") {
    if (detailId !== id) {
      folderViewId = null;
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
  if (name === "rename-file") {
    const target = {
      volume: historyVolume,
      path: historyPath,
      rev: historyVersions[0]?.rev,
    };
    modal(
      modalHeader(
        "Rename file",
        "The new name syncs to other copies. Earlier history stays under the previous name.",
        "pencil",
      ) + textField("Filename", "name", target.path.split("/").at(-1)),
      async (form) => {
        await api("/v1/rename-file", { ...target, name: form.get("name") });
        view = "folders";
        detailId = target.volume;
        historyPath = null;
        fileOriginFolder = null;
        notice("File renamed.");
      },
      "Rename",
    );
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
        const restored = await api("/v1/restore", {
          volume: historyVolume,
          path: historyPath,
          rev: Number(id),
        });
        await api("/v1/sync", { background: true });
        notice(
          `Version restored: ${historyPath}${restored.rev ? ` as rev ${restored.rev}` : ""}`,
          false,
          {
            action: "folder-history",
            actionLabel: "Show",
            volume: historyVolume,
          },
        );
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
          version: APP_VERSION,
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
  if (
    (name === "destroy-replica" && status.role === "replica") ||
    (name === "destroy-hub" && status.role === "hub")
  ) {
    const destroyingHub = status.role === "hub";
    const paths = [
      ...new Set(
        [
          ...(status.volumes || []).map((v) => v.path),
          status.backup?.path,
        ].filter(Boolean),
      ),
    ];
    modal(
      modalHeader(
        destroyingHub ? "Destroy this hub?" : "Destroy this replica?",
        destroyingHub
          ? "Permanently deletes this hub’s shared folders, files, revision history and configuration. Replicas keep their local files and lose access to this hub. Arca returns to setup, where you can choose hub or replica."
          : "Permanently deletes local folders, including unsynced changes, and resets Arca on this machine. Hub files, hub history and other machines are kept.",
        "trash-2",
      ) +
        `<ul>${paths.map((p) => `<li class="path">${escape(p)}</li>`).join("")}</ul><p class="hint">This cannot be undone. ${destroyingHub ? "No deletions are sent to replicas." : "Works offline. If the hub cannot be reached, remove this machine from its Machines list separately."} An interrupted cleanup can be retried.</p>`,
      async () => {
        await api(destroyingHub ? "/v1/destroy-hub" : "/v1/destroy-replica", {
          confirmed: true,
        });
        ready = false;
        detailId = null;
        onboarding = null;
        localStorage.removeItem("arca-theme");
        theme("system");
        if (native) await boot();
        else
          await showLogin(
            `${destroyingHub ? "Hub" : "Replica"} destroyed. Generate a new local web access code to begin setup.`,
          );
      },
      destroyingHub ? "Destroy hub" : "Destroy replica",
      true,
    );
    $("#submit-dialog").classList.add("danger");
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
        catalogLoaded = false;
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
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return;
  }
  if (name === "sync") {
    await api("/v1/sync", { background: true });
    void background(() => refresh());
    return;
  }
  if (name === "pause") {
    const paused = status.phase !== "paused";
    await api("/v1/pause", { paused });
    if (!paused) await api("/v1/sync", { background: true });
    void background(() => refresh());
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
      modal(
        modalHeader(
          "Choose folders",
          "Keep complete copies on this machine.",
          "folder",
        ),
        async () => {},
        "Done",
      );
      $("#dialog-content").insertAdjacentHTML(
        "beforeend",
        '<div class="empty">' +
          icon("folder-check") +
          "<h3>All folders are selected</h3><p>New shared folders will appear here when the hub creates them.</p></div>",
      );
      icons();
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
  if (name === "images-refresh") return imageLibrary();
  if (name === "images-cancel") {
    await api("/v1/images", { action: "cancel" });
    return imageLibrary();
  }
  if (["images-analyze", "images-regenerate"].includes(name)) {
    await api("/v1/images", { action: name.slice(7) });
    return imageLibrary();
  }
  if (name === "images-optimize") {
    modal(
      modalHeader(
        "Convert JPEG library to HEIC?",
        "This replaces eligible JPEG paths with verified HEIC files and synchronizes the change to working replicas. Conversion is lossy at quality 85, without resizing. Files that lose checked metadata or save less than 10% are skipped. Linked phone originals stay unchanged. Old JPEG revisions and backups continue to occupy space until their retention policies allow cleanup. Changed files and occupied destinations are skipped.",
        "images",
      ),
      async () => {
        await api("/v1/images", { action: "optimize", confirmation: id });
        return () => imageLibrary();
      },
      "Convert library",
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
const navigationActions = new Set([
  "unselect",
  "enable-gallery",
  "delete-share",
  "rename-share",
  "rename-file",
  "delete-file",
  "connect",
  "replacement-hub",
  "refresh",
  "gallery-mode",
  "folder-tab",
  "browse-directory",
  "browse-page",
  "folder-search-toggle",
  "folder-search-apply",
  "back-folders",
  "folder-detail",
  "folder-history",
  "folder-conflicts",
  "history-folder",
  "history-filter",
  "history-page",
  "history-open-file",
  "history-reveal-file",
  "history-view-folder",
  "history-back",
  "file-back-folder",
  "activity-file",
  "versions",
  "machines",
  "backup-settings",
  "folder-problem",
  "review-conflict",
  "open-conflict",
  "copy",
  "copy-notice",
  "diagnostics",
  "theme",
  "open",
]);
function dispatchControl(control) {
  const { action: name, id } = control.dataset;
  const work = () => handle(name, id, control);
  return navigationActions.has(name) ? navigate(work) : action(work, control);
}
document.addEventListener("click", (e) => {
  document
    .querySelectorAll(".file-actions-menu[open]")
    .forEach((menu) => {
      if (!menu.contains(e.target) || e.target.closest("[data-action]"))
        menu.open = false;
    });
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
    dispatchControl(option).then(() =>
      document.getElementById(triggerId)?.focus(),
    );
    return;
  }
  const nav = e.target.closest("[data-view]");
  if (nav) {
    e.preventDefault();
    if (!ready || $("#dialog").open) return;
    view = nav.dataset.view;
    detailId = null;
    historyPath = null;
    updateShell();
    const loading = viewLoadSerial + 1;
    void render({ refreshStatus: true }).catch((error) => {
      if (!window.document || loading !== viewLoadSerial) return;
      if (!native && error.status === 401)
        void showLogin("Your session has ended. Enter a new web access code.");
      else
        notice(error.message, true, {
          id: "view:" + view,
          action: "refresh",
          actionLabel: "Retry now",
        });
    });
    return;
  }
  const control = e.target.closest("[data-action]");
  if (!control) return;
  e.preventDefault();
  if (["copy-pair", "new-pair"].includes(control.dataset.action)) return;
  if (control.dataset.action === "dismiss") {
    void handle(control.dataset.action, control.dataset.id, control);
    return;
  }
  dispatchControl(control);
});
document.addEventListener("change", (e) => {
  const control = e.target;
  const enabled = control.checked;
  if (control.matches("[data-backup-toggle]")) {
    control.checked = Boolean(status.backup?.enabled);
    action(
      () => handle(enabled ? "enable-backup" : "disable-backup", ""),
      control,
    );
    return;
  }
  if (
    !["allow-lan-http", "launch-at-login", "notifications-enabled"].includes(
      control.id,
    )
  )
    return;
  action(async () => {
    try {
      if (control.id === "allow-lan-http")
        network = await api("/v1/network/lan", { enabled });
      else
        await invoke(
          control.id === "launch-at-login"
            ? "set_launch_at_login"
            : "set_notifications",
          { enabled },
        );
    } catch (error) {
      control.checked = !enabled;
      throw error;
    }
  }, control);
});

function requestReference(reference, label = "REQUEST", hint = "") {
  const digits = String(reference || "");
  return `<div class="request-reference"><div class="eyebrow">${escape(label)}</div><div class="request-number" aria-label="${escape(digits)}"><span>${escape(digits.slice(0, 3))}</span><span class="request-separator" aria-hidden="true">–</span><span>${escape(digits.slice(3))}</span></div>${hint ? `<p>${escape(hint)}</p>` : ""}</div>`;
}
function requestRemaining(expires) {
  const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
let approvalModal = null;
let checkingApprovals = false;
async function checkWebApprovals() {
  if (!ready || checkingApprovals || document.visibilityState === "hidden")
    return;
  checkingApprovals = true;
  try {
    const data = await api("/v1/web-approvals");
    if (!ready) return;
    if (approvalModal && !data.requests.some((r) => r.id === approvalModal)) {
      if ($("#dialog").dataset.approval === approvalModal) $("#dialog").close();
      approvalModal = null;
    }
    if (busy || $("#dialog").open || !data.requests.length) return;
    const r = data.requests[0];
    approvalModal = r.id;
    modal(
      modalHeader(
        `Allow this browser to open ${escape(status.hubName || status.name)}?`,
        `Someone is signing in to the hub web from a browser. Allow it only if that is you, right now.`,
        "log-in",
      ) +
        requestReference(r.reference, "REQUEST · must match the browser") +
        `<div class="approval-details">${[
          ["globe", "Browser", escape(r.browser || "Browser")],
          ["shield-check", "From", `<span class="mono">${escape(r.ip)}</span>`],
          ["clock", "Requested", `<span id="approval-time"></span>`],
        ]
          .map(
            ([symbol, label, value]) =>
              `<div class="approval-detail">${icon(symbol)}<span>${label}</span><strong>${value}</strong></div>`,
          )
          .join("")}</div>
        <details class="approval-raw"><summary>${icon("chevron-right")}Raw details, as reported by the browser</summary><p>${escape(r.agent)}</p></details>`,
      async () => {
        await api("/v1/web-approvals", { id: r.id, decision: "allow" });
        approvalModal = null;
      },
      "Allow",
    );
    $("#dialog").dataset.approval = r.id;
    $("#dialog").classList.add("approval-dialog");
    const footer = document.createElement("p");
    footer.className = "hint approval-session";
    footer.textContent = "Grants a 24-hour session on that browser.";
    $("#dialog .dialog-actions").prepend(footer);
    const updateTime = () => {
      const time = $("#approval-time");
      if (time)
        time.textContent = `${r.created && Date.now() - r.created >= 60000 ? `${Math.floor((Date.now() - r.created) / 60000)} min ago` : "Just now"} · expires in ${requestRemaining(r.expires || Date.now())}`;
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    const cancel = $("#cancel-dialog");
    const previousCancel = cancel.onclick;
    $("#dialog").addEventListener(
      "close",
      () => {
        clearInterval(timer);
        footer.remove();
        cancel.onclick = previousCancel;
        delete $("#dialog").dataset.approval;
        if (approvalModal === r.id) {
          approvalModal = null;
          void api("/v1/web-approvals", { id: r.id, decision: "deny" }).catch(
            () => {},
          );
        }
      },
      { once: true },
    );
    cancel.textContent = "Deny";
    cancel.onclick = () =>
      action(async () => {
        await api("/v1/web-approvals", { id: r.id, decision: "deny" });
        approvalModal = null;
        $("#dialog").close();
      });
  } catch {
    /* Offline/older hubs keep their existing sign-in path. */
  } finally {
    checkingApprovals = false;
  }
}
setInterval(() => {
  void checkWebApprovals();
}, 3000);
async function showLogin(message = "") {
  clearStoredGallery();
  viewLoadSerial++;
  historyCache.clear();
  clearGalleryPages();
  for (const pool of Object.values(photoCaches)) {
    pool.entries.clear();
    pool.bytes = 0;
  }
  photoRequests.clear();
  viewReads.clear();
  folderCacheEpoch++;
  folderPages.clear();
  document.body.classList.remove("view-loading");
  $("#content").setAttribute("aria-busy", "false");
  ready = false;
  status = null;
  renderSerial++;
  if ($("#dialog").open) $("#dialog").close();
  document.body.classList.add("access-mode");
  const loginSerial = renderSerial;
  $("#content").innerHTML =
    '<div class="page" role="status">Checking server setup…</div>';
  const info = await fetch("/.well-known/arca")
    .then((response) => response.json())
    .catch(() => null);
  if (loginSerial !== renderSerial) return;
  if (info?.service === "arca" && info.access?.setupRequired === true) {
    onboarding = {
      step: -1,
      name: "",
      role: "replica",
      root: "",
      url: "",
      code: "",
      serverAccessRequired: true,
      setupCodePath: info.access?.setupCodePath === "/umbrel" ? "/umbrel" : "",
    };
    renderOnboarding();
    return;
  }
  $("#content").innerHTML =
    `<div class="access-page"><div class="access-brand"><div class="access-logo"><img src="assets/arca-icon.svg" width="56" height="56" alt=""><h1>arca</h1></div><p><span id="access-role" class="tag" hidden></span> <span class="mono"><span id="access-name"></span> ${escape(location.host)}</span></p></div><div class="access-card">
    <div id="access-methods" hidden>${segmented(
      "Sign-in method",
      [
        { label: "Enter a code", action: "login-code", active: true },
        { label: "Approve on a machine", action: "login-approval" },
      ],
      "access-tabs",
    )}</div>
    <div id="access-code"><form id="web-login"><label>Web access code</label>${codeFields("web")}<p class="hint">${icon("clock")} Single use · valid ten minutes from generation</p><p id="login-error" role="alert">${escape(message)}</p><button class="primary" type="submit">${icon("log-in")}Open Arca</button></form><div class="access-help"><h3>Get a code</h3><p>On the server run <code>arca web-code</code></p><p>and copy the code value from the reply.</p></div></div>
    <div id="access-approval" hidden><div id="web-approval-wait"></div><button type="button" id="request-web-approval" class="secondary">Try again</button></div>
    <p class="session-note">Signed in for up to 24 hours, until sign-out or a server restart.<br>No username or password.</p></div></div>`;
  icons();
  let approvalAvailable = info?.access?.machineApproval === true;
  if (info?.service === "arca") {
    $("#access-name").textContent = `${info.name} ·`;
    $("#access-role").textContent = info.role;
    $("#access-role").hidden = false;
    $("#access-methods").hidden = !approvalAvailable;
    if (info.access?.setupCodePath === "/umbrel")
      $(".access-help").innerHTML =
        '<h3>Get a code</h3><p><a href="/umbrel" target="_blank" rel="noopener">Open Umbrel code access</a>, then return here.</p>';
  }
  let cancelApproval = () => {};
  const chooseMethod = (approval) => {
    if (approval && !approvalAvailable) return;
    cancelApproval();
    $("#access-code").hidden = approval;
    $("#access-approval").hidden = !approval;
    document
      .querySelectorAll(".access-tabs button")
      .forEach((button, index) => {
        button.classList.toggle("active", Boolean(index) === approval);
        button.setAttribute(
          "aria-pressed",
          String(Boolean(index) === approval),
        );
      });
    if (approval) void startApproval();
  };
  document.querySelectorAll(".access-tabs button").forEach((button, index) => {
    button.onclick = (event) => {
      event.stopPropagation();
      chooseMethod(Boolean(index));
    };
  });
  async function startApproval() {
    const button = $("#request-web-approval"),
      wait = $("#web-approval-wait");
    button.hidden = true;
    wait.innerHTML = `<p class="approval-countdown">${busyIcon()}Requesting access…</p>`;
    let request,
      cancelled = false,
      timer;
    cancelApproval = () => {
      cancelled = true;
    };
    try {
      request = await browserRequest("/auth/approval", { action: "create" });
      if (cancelled || !wait.isConnected || ready) return;
      wait.innerHTML =
        requestReference(
          request.reference,
          "REQUEST",
          "Approve only if the machine shows this same number.",
        ) +
        `<p class="approval-instructions">Open Arca on an authorized machine or your phone.</p><p class="approval-countdown">${busyIcon()}<span id="request-countdown"></span></p><button type="button" class="secondary">Cancel request</button>`;
      const tick = () => {
        const el = wait.querySelector("#request-countdown");
        if (el)
          el.textContent = `Expires in ${requestRemaining(request.expires)}`;
      };
      tick();
      timer = setInterval(tick, 1000);
      wait.querySelector("button").onclick = () => chooseMethod(false);
      while (!cancelled && wait.isConnected && !ready) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (cancelled || !wait.isConnected || ready) break;
        const result = await browserRequest("/auth/approval", {
          ...request,
          action: "poll",
        });
        if (cancelled || !wait.isConnected) break;
        if (result.state === "approved") {
          await action(() => refresh());
          return;
        }
        if (result.state !== "pending") {
          wait.textContent =
            result.state === "denied"
              ? "Access denied."
              : "Request expired. Try again.";
          return;
        }
      }
    } catch (error) {
      if (!cancelled && wait.isConnected) wait.textContent = error.message;
    } finally {
      clearInterval(timer);
      if (request)
        void browserRequest("/auth/approval", {
          ...request,
          action: "cancel",
        }).catch(() => {});
      if (!cancelled && button.isConnected && !ready) button.hidden = false;
    }
  }
  $("#request-web-approval").onclick = startApproval;
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
      $("#content").innerHTML =
        title("Folders") + `<div class="page">${scaffoldRow()}</div>`;
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
  ready = false;
  document.body.classList.remove("access-mode");
  document.body.classList.add("onboarding-mode");
  const o = onboarding;
  const activeStep = o.step === "access" ? 1 : o.step;
  const steps = [
    "Name this machine",
    "Choose its role",
    "Pair with your hub",
    "Pick a folder root",
  ];
  let body = "";
  if (o.step === -1)
    body = `<p>Your personal drive, on your own machines.</p><h1>Many devices.<br><em class="accent-text">One space.</em></h1><p>Arca keeps the folders you choose in sync across your laptop, tablet and phone, with complete local copies and a hub you run yourself.</p>${[
      [
        "hard-drive",
        "Complete local copies",
        "Real files on your disk. Offline is a normal day.",
      ],
      [
        "history",
        "A way back",
        "Restore earlier versions. Conflicts keep both files.",
      ],
      [
        "server",
        "A hub you control",
        "Your storage, your machines. No cloud account, no telemetry.",
      ],
    ]
      .map(
        ([symbol, heading, description]) =>
          `<div class="settings-card">${setting(heading, description, "", icon(symbol))}</div>`,
      )
      .join("")}`;
  if (o.step === 0)
    body = `<h1>Name this machine</h1><p>Shown to other machines and in history.</p>${textField("Machine name", "name", o.name, "monitor")}${o.platform ? `<p class="hint">${escape(platformLabel(o.platform))}${o.arch ? ` · ${escape(o.arch)}` : ""}</p>` : ""}`;
  if (o.step === 1)
    body = `<h1>What is ${escape(o.name)}?</h1><p>A hub keeps your folders. Every other machine keeps a copy.</p>${[
      [
        "hub",
        "server",
        "Make it the hub",
        "Keeps the folders and their history.",
      ],
      [
        "replica",
        "monitor-smartphone",
        "Join an existing hub",
        "Keeps the folders you select. Needs a pairing code from the hub.",
      ],
    ]
      .map(
        ([value, symbol, name, desc]) =>
          `<label class="role-card"><input name="role" type="radio" value="${value}" ${o.role === value ? "checked" : ""}>${icon(symbol)}<div><strong>${name}</strong><p>${desc}</p></div></label>`,
      )
      .join("")}`;
  if (o.step === "access")
    body = `<h1>Confirm server access</h1><p>Enter a web access code to save this server's configuration.</p>${o.setupCodePath ? '<p><a href="/umbrel" target="_blank" rel="noopener">Get a code from Umbrel</a>, then return here.</p>' : "<p>On this server, run <code>arca web-code</code> and copy the code from the reply.</p>"}<label>Web access code</label>${codeFields("setup-access")}<p class="hint">Single use · valid ten minutes. This is not a hub pairing code.</p>`;
  if (o.step === 2 && !o.paired)
    body = `<h1>Pair with your hub</h1><p>Connect with a single-use code from your hub.</p>${textField("Hub address", "url", o.url, "server", "https://arca.your-network", "mono")}<label>Pairing code</label>${codeFields("onboarding")}<p class="hint">${icon("clock")}Single use · valid ten minutes.</p>`;
  if (o.step === 2 && o.paired)
    body = `<h1>Finish setup</h1><p>Paired with ${escape(o.hubName || "your hub")}. Your connection is saved.</p><p>No folders have been downloaded. Choose them after setup.</p>`;
  if (o.step === 3)
    body = `<h1>A home for your folders</h1><p>${o.role === "replica" ? "Folders you select from the hub live here, as ordinary folders." : "Choose a default location for the folders you share."}</p><div class="root-selection"><div class="tile large">${icon("folder")}</div><div class="row-main"><strong>Folder root</strong><input aria-label="Folder root" class="mono" name="root" value="${escape(o.root)}" required></div>${native ? button("Change…", "pick-path", "root", "secondary small-button", "folder-input") : ""}</div><div id="setup-space"></div><p class="hint">Must be empty or new. Nothing is downloaded until you select folders.</p>${native ? "" : '<p class="hint">This path is on the server. In Docker or Umbrel, use persistent mounted storage; the default is /data/files.</p>'}`;
  $("#content").innerHTML =
    `<div class="onboarding"><div class="onboarding-rail"><div class="brand"><img src="assets/arca-icon.svg" width="28" height="28" alt="Arca"><b>arca</b></div><div class="steps">${steps.map((label, i) => `<div class="step ${activeStep === i ? "current" : activeStep > i && !(o.role === "hub" && i === 2) ? "done" : ""}" ${activeStep === i ? 'aria-current="step"' : ""}><span>${activeStep > i && !(o.role === "hub" && i === 2) ? icon("check") : i + 1}</span>${label}${i === 2 && o.role === "hub" && o.step > 0 ? " · Not needed" : ""}</div>`).join("")}</div></div><form id="setup-form" class="onboarding-body">${body}<p id="setup-error" class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" id="setup-back" class="ghost" ${o.step < 0 || o.initialized ? "disabled" : ""}>${icon("chevron-left")}Back</button><button type="submit" class="primary">${o.step < 0 ? "Get started" : o.step === 3 ? "Finish" : "Continue"}${icon("chevron-right")}</button></div></form></div>`;
  $("#setup-back").onclick = () => {
    o.step =
      o.step === "access"
        ? 1
        : o.step === 3 && o.role === "hub"
          ? 1
          : o.step - 1;
    renderOnboarding();
  };
  const showError = (error) => {
    if (onboarding !== o || !$("#setup-error")) return;
    $("#setup-error").hidden = false;
    $("#setup-error").textContent = error.message;
  };
  const inspectRoot = async () => {
    const root = $("[name=root]")?.value || o.root;
    const result = await (native
      ? invoke("setup_info", { root })
      : api(`/v1/setup-info?root=${encodeURIComponent(root)}`));
    if (onboarding === o && o.step === 3 && $("[name=root]")?.value === root)
      $("#setup-space").innerHTML =
        `<div class="stats"><div class="stat"><span>Available space</span><strong>${bytes(result.freeBytes)}</strong></div>${o.totalBytes !== undefined ? `<div class="stat"><span>On hub ${escape(o.hubName || "")}</span><strong>${bytes(o.totalBytes)}</strong><p>${o.folderCount} folders</p></div>` : ""}</div>`;
    return result;
  };
  if (o.step === 3) {
    inspectRoot().catch(showError);
    $("[name=root]").onchange = () => inspectRoot().catch(showError);
  }
  $("#setup-form").onsubmit = (event) => {
    event.preventDefault();
    action(async () => {
      try {
        const f = new FormData(event.target);
        if (o.step === -1) {
          o.step = 0;
          renderOnboarding();
          return;
        }
        if (o.step === 0) {
          o.name = String(f.get("name")).trim();
          if (!o.name || o.name.length > 100)
            throw new Error("Choose a name of up to 100 characters.");
          o.step = 1;
          renderOnboarding();
          return;
        }
        if (o.step === 1) {
          o.role = f.get("role");
          o.step = o.serverAccessRequired ? "access" : o.role === "hub" ? 3 : 2;
          renderOnboarding();
          return;
        }
        if (o.step === "access") {
          const code = readCode("setup-access");
          if (code.length !== 6) throw new Error("Enter all six digits.");
          if (o.serverAccessRequired) {
            await browserRequest("/auth/login", { code });
            o.serverAccessRequired = false;
          }
          const current = await api("/v1/status");
          if (!current.needsSetup || current.onboarding) {
            onboarding = null;
            await refresh();
            return;
          }
          o.root = current.root;
          o.step = o.role === "hub" ? 3 : 2;
          renderOnboarding();
          return;
        }
        if (o.step === 2 && !o.paired) {
          o.url = String(f.get("url")).trim();
          if (!o.url) throw new Error("Enter your hub address.");
          if (readCode("onboarding").length !== 6 && !o.initialized)
            throw new Error("Enter all six digits.");
        }
        if (o.step === 3) o.root = (await inspectRoot()).root;
        if (!o.initialized) {
          await (
            native
              ? (data) => invoke("initialize", data)
              : (data) => api("/v1/setup", { ...data, onboarding: true })
          )({ name: o.name, role: o.role, root: o.root });
          o.initialized = true;
        }
        let current;
        for (let i = 0; i < 30; i++) {
          try {
            current = await api("/v1/status");
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (!current) throw new Error("Daemon is still starting. Try again.");
        if (o.step === 2) {
          o.url = String(f.get("url") || o.url).trim();
          const code = readCode("onboarding");
          if (!current.hub) {
            if (code.length !== 6) throw new Error("Enter all six digits.");
            try {
              await api("/v1/connect", { url: o.url, code });
            } catch (error) {
              if (!(await api("/v1/status")).hub) throw error;
              o.paired = true;
              renderOnboarding();
              // The credential is already durable; a catalog retry must not reuse the code.
            }
          }
          const catalog = await api("/v1/remote");
          o.paired = true;
          o.hubName = catalog.name;
          o.totalBytes = catalog.volumes.every((v) => Number.isFinite(v.bytes))
            ? catalog.volumes.reduce((sum, v) => sum + v.bytes, 0)
            : undefined;
          o.folderCount = catalog.volumes.length;
          o.step = 3;
          renderOnboarding();
          return;
        }
        await api("/v1/setup", { name: o.name, role: o.role, root: o.root });
        onboarding = null;
        await refresh();
      } catch (error) {
        showError(error);
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
      step: -1,
      name: state.name || "",
      platform: state.platform,
      arch: state.arch,
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
      `<div class="page">${empty("Your files remain on disk", state.error ? escape(state.error) : "Start the local daemon to check your folders.", button("Start service", "start", "", "primary", "power"))}</div>`;
    icons();
  } else await refresh();
}
await action(boot);
let pointerPressed = false;
window.addEventListener("pointerdown", () => {
  pointerPressed = true;
});
window.addEventListener("pointerup", () => {
  pointerPressed = false;
});
window.addEventListener("pointercancel", () => {
  pointerPressed = false;
});
window.addEventListener("blur", () => {
  pointerPressed = false;
});
let polling = false,
  eventsHealthyAt = 0,
  lastStatusPoll = 0;
async function pollStatus(force = false) {
  if (!ready || polling) return;
  if (
    !force &&
    Date.now() - eventsHealthyAt < 20000 &&
    Date.now() - lastStatusPoll < 30000 &&
    !busy &&
    !["syncing", "scanning"].includes(status?.phase)
  )
    return;
  lastStatusPoll = Date.now();
  polling = true;
  const serial = renderSerial;
  try {
    const old = lastSignature;
    const signature = await refresh(false);
    // Background reads must neither swallow clicks nor replace a newer view.
    if (
      !busy &&
      !pointerPressed &&
      !$("#dialog").open &&
      !document.querySelector(
        '.details-menu[open], .dropdown [aria-expanded="true"]',
      ) &&
      !document.activeElement?.matches(
        "input, textarea, [contenteditable=true]",
      ) &&
      serial === renderSerial &&
      ["folders", "devices"].includes(view) &&
      old !== signature &&
      !(view === "folders" && detailId && folderTab === "gallery")
    ) {
      const positions = [...document.querySelectorAll("#content, #content *")]
        .filter((el) => el.scrollTop || el.scrollLeft)
        .map((el) => {
          const path = [];
          for (
            let node = el;
            node && node.id !== "content";
            node = node.parentElement
          )
            path.unshift(
              `:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`,
            );
          return {
            el,
            id: el.id,
            selector:
              "#content" + (path.length ? " > " + path.join(" > ") : ""),
            top: el.scrollTop,
            left: el.scrollLeft,
          };
        });
      const focused = document.activeElement;
      const focusAction = focused?.dataset.action;
      const focusId = focused?.dataset.id;
      await render();
      if (serial + 1 === renderSerial) {
        for (const position of positions) {
          const element = position.el.isConnected
            ? position.el
            : (position.id && document.getElementById(position.id)) ||
              document.querySelector(position.selector);
          if (element) {
            element.scrollTop = position.top;
            element.scrollLeft = position.left;
          }
        }
        if (focusAction)
          [...document.querySelectorAll("[data-action]")]
            .find(
              (el) =>
                el.dataset.action === focusAction && el.dataset.id === focusId,
            )
            ?.focus({ preventScroll: true });
      }
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
}
setInterval(pollStatus, 5000);
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
async function checkForUpdate() {
  if (!native || navigator.onLine === false) return null;
  try {
    const update = await invoke("check_update");
    showUpdate(update);
    return update;
  } catch {
    // Offline, an unreachable manifest or a rejected signature must stay silent.
    return null;
  }
}
function showUpdate(update) {
  const card = $("#update-card");
  if (!card) return;
  card.hidden = !update?.available;
  if (!update?.available) return;
  $("#update-versions").textContent = `${APP_VERSION} → ${update.version}`;
}
if (native) {
  void checkForUpdate();
  setInterval(checkForUpdate, UPDATE_INTERVAL);
  window.addEventListener("online", () => void checkForUpdate());
}
let eventRequest = false,
  eventCursor = null,
  eventRetry = 0;
setInterval(async () => {
  if (!ready || document.hidden || eventRequest || Date.now() < eventRetry)
    return;
  eventRequest = true;
  try {
    // Waiting for events is idle work, not visible loading activity.
    const next = await invoke("api", {
      route: `/v1/events?${new URLSearchParams(eventCursor ? { after: eventCursor } : {})}`,
      method: "GET",
      body: null,
    });
    if (!document?.body || !ready) return;
    eventsHealthyAt = Date.now();
    if (next.cursor !== eventCursor) {
      eventCursor = next.cursor;
      document.dispatchEvent(new Event("arca-changes"));
      await pollStatus(true);
    }
  } catch {
    eventRetry = Date.now() + 30000;
  } finally {
    eventRequest = false;
  }
}, 1000);
if (native && window.__TAURI__.event) {
  window.__TAURI__.event.listen("notice-action", (event) =>
    action(async () => {
      const data = event.payload || {};
      if (
        !["review", "retry", "pair", "backup", "folder"].includes(data.action)
      )
        return;
      await refresh();
      if (data.action === "review") {
        view = "history";
        historyVolume = typeof data.volume === "string" ? data.volume : "";
        historyPath = null;
        historyFilter = "conflicts";
      } else if (data.action === "backup" || data.action === "pair")
        view = "settings";
      else {
        view = "folders";
        detailId = status.volumes.some((v) => v.id === data.volume)
          ? data.volume
          : null;
        if (data.execute && data.action === "retry")
          await api("/v1/sync", { background: true });
      }
      await render();
      updateShell();
    }),
  );

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

// File actions use a native disclosure, with keyboard dismissal and focus return.
document.addEventListener("keydown", (event) => {
  const menu = event.target.closest(
    ".file-actions-menu[open]",
  );
  if (menu && event.key === "Escape") {
    event.preventDefault();
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});
document.addEventListener("focusin", (event) => {
  document
    .querySelectorAll(".file-actions-menu[open]")
    .forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
});


// Shared icon action: its tooltip is also its accessible name.
function iconAction(label, action, symbol, disabled = false) {
  return `<button type="button" class="ghost icon-button" data-action="${escape(action)}" data-tooltip="${escape(label)}" aria-label="${escape(label)}" ${disabled ? "disabled" : ""}>${icon(symbol)}</button>`;
}
function installTooltips() {
  let timer, trigger, tip;
  const close = () => {
    clearTimeout(timer);
    if (trigger && tip) {
      const ids = (trigger.getAttribute("aria-describedby") || "").split(" ").filter(id => id && id !== tip.id);
      if (ids.length) trigger.setAttribute("aria-describedby", ids.join(" "));
      else trigger.removeAttribute("aria-describedby");
    }
    tip?.remove();
    tip = trigger = null;
  };
  const open = (target) => {
    if (target === trigger) return;
    close();
    if (!target || target.disabled) return;
    trigger = target;
    timer = setTimeout(() => {
      if (!target.isConnected) return close();
      tip = document.createElement("span");
      tip.id = "arca-tooltip";
      tip.className = "tooltip";
      tip.setAttribute("role", "tooltip");
      tip.textContent = target.dataset.tooltip;
      (target.closest("dialog[open]") || document.body).append(tip);
      target.setAttribute("aria-describedby", [target.getAttribute("aria-describedby"), tip.id].filter(Boolean).join(" "));
      const rect = target.getBoundingClientRect();
      const bounds = tip.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8));
      const top = rect.top >= bounds.height + 14 ? rect.top - bounds.height - 6 : rect.bottom + 6;
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
    }, 200);
  };
  document.addEventListener("pointerover", event => open(event.target.closest("[data-tooltip]")));
  document.addEventListener("pointerout", event => {
    if (trigger && !trigger.contains(event.relatedTarget)) close();
  });
  document.addEventListener("focusin", event => open(event.target.closest("[data-tooltip]")));
  document.addEventListener("focusout", close);
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  document.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  new MutationObserver(() => { if (trigger && !trigger.isConnected) close(); }).observe(document.body, { childList: true, subtree: true });
}
installTooltips();
