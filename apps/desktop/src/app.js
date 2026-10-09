import { timelineSegments } from "./gallery-timeline-layout.js";
import {
  artistGroups,
  artistId,
  buildLibrary,
  formatDuration,
  nextRepeat,
  playedItems,
  rememberPlayed,
  searchText,
  shuffleOrder,
} from "./music-library.js";
import {
  createNoticeStore,
  errorNotice,
  conditionNotices,
  safeDetails,
  HUB_ONLY_REASON,
} from "./notice-contract.js";
import { fileIcon } from "./file-icons.js";
const folderPages = new Map();
let folderCacheEpoch = 0;
const folderPageKey = (route) =>
  `${status?.id}:${status?.hubId || status?.id}:${route}`;
const MAX_FOLDER_PAGES = 5;
function knownFolderPage(route) {
  return folderPages.get(folderPageKey(route));
}
const recentSaved = new Map();
const recentFailed = new Set();
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
const APP_VERSION = "0.7.28";
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
function dayLabel(value, now = new Date()) {
  const day = new Date(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day.toDateString() === now.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
const clockTime = (value) =>
  new Date(value).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
const icon = (name) => `<span data-icon="${name}" aria-hidden="true"></span>`;
const busyIcon = () =>
  '<span class="busy-grid" aria-hidden="true">' +
  "<i></i>".repeat(9) +
  "</span>";
const paletteKey = /Mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘K" : "Ctrl K";
document.querySelectorAll(".palette-key").forEach((el) => (el.textContent = paletteKey));
let palette = null;
const PALETTE_RECENT = "arca-palette-recent";
const paletteRecent = () => {
  try {
    const list = JSON.parse(localStorage.getItem(PALETTE_RECENT) || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
};
function rememberPalette(query) {
  const text = query.trim();
  if (!text) return;
  try {
    localStorage.setItem(PALETTE_RECENT, JSON.stringify([text, ...paletteRecent().filter((x) => x !== text)].slice(0, 5)));
  } catch {
    /* Private storage only disables recent searches. */
  }
}
function paletteActions() {
  const paused = status.phase === "paused";
  return [
    { type: "action", name: "sync", label: "Sync now", symbol: "refresh-cw" },
    { type: "action", name: "pause", label: paused ? "Resume sync" : "Pause sync", symbol: paused ? "play" : "pause" },
    status.role === "hub"
      ? { type: "action", name: "share", label: "Create shared folder", symbol: "folder-plus" }
      : { type: "action", name: "add", label: "Choose folders…", symbol: "folder-plus" },
    { type: "action", name: "settings", label: "Open Settings", symbol: "settings" },
  ];
}
function paletteDialog() {
  let dialog = document.getElementById("palette");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "palette";
    dialog.className = "palette";
    dialog.setAttribute("aria-label", "Search Arca");
    dialog.addEventListener("close", () => {
      const back = palette?.opener;
      clearTimeout(palette?.timer);
      palette = null;
      if (back?.isConnected) back.focus();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
  }
  return dialog;
}
function paletteRows(data) {
  const rows = [];
  const query = palette.query.trim();
  if (!query) {
    rows.push(...paletteRecent().map((text) => ({ type: "recent", text, group: "Recent searches" })));
    rows.push(...paletteActions().map((row) => ({ ...row, group: "Actions" })));
    return rows;
  }
  if (data) {
    rows.push(...data.folders.map((row) => ({ type: "folder", group: "Folders", count: data.counts.folders, ...row })));
    rows.push(...data.files.map((row) => ({ type: "file", group: "Files", count: data.counts.files, ...row })));
    rows.push(...data.photos.map((row) => ({ type: "photo", group: "Photos", count: data.counts.photos, ...row })));
    rows.push(...data.music.map((row) => ({ type: "music", group: "Music", count: data.counts.music, ...row })));
  }
  if (query.length >= 2 && palette.scope === "all")
    rows.push(...paletteActions().filter((row) => row.label.toLowerCase().includes(query.toLowerCase())).map((row) => ({ ...row, group: "Actions" })));
  return rows;
}
function paletteRowMarkup(row, index) {
  const active = index === palette.active ? " pal-active" : "";
  const option = `role="option" aria-selected="${index === palette.active}" id="pal-${index}" data-pal="${index}"`;
  if (row.type === "recent")
    return `<div class="pal-row${active}" ${option}><span class="pal-icon">${icon("clock")}</span><div><strong>${escape(row.text)}</strong></div></div>`;
  if (row.type === "action")
    return `<div class="pal-row${active}" ${option}><span class="pal-icon">${icon(row.symbol)}</span><div><strong>${escape(row.label)}</strong></div></div>`;
  if (row.type === "folder")
    return `<div class="pal-row${active}" ${option}><span class="pal-icon">${icon("folder")}</span><div><strong>${escape(row.name)}</strong></div></div>`;
  if (row.type === "photo")
    return `<div class="pal-cell${active}" ${option}><span class="pal-thumb" data-pal-photo="${index}">${icon(row.kind === "video" ? "play" : "image")}</span><span class="pal-cap">${escape(row.name)}</span></div>`;
  if (row.type === "music")
    return `<div class="pal-row${active}" ${option}><span class="pal-icon">${icon("music")}</span><div><strong>${escape(row.title || row.name)}</strong><p>${escape([row.artist, row.album].filter(Boolean).join(" · ") || row.folder)}</p></div></div>`;
  return `<div class="pal-row${active}" ${option}><span class="pal-icon">${icon(fileIcon(row.path))}</span><div><strong>${escape(row.name)}</strong><p>${escape(row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : row.folder)} · ${escape(bytes(row.size))}</p></div></div>`;
}
function paintPalette(data) {
  if (!palette) return;
  const rows = (palette.rows = paletteRows(data));
  palette.active = Math.min(palette.active, Math.max(0, rows.length - 1));
  const body = document.querySelector("#palette .pal-body");
  const query = palette.query.trim();
  if (query && data && !rows.length) {
    body.innerHTML = empty(`No matches for “${escape(query)}”`, "Search covers file names, photos and music held on this device.", "", "search");
  } else {
    let html = "";
    let group = "";
    const close = () => (group === "Photos" ? "</div></div>" : "</div>");
    rows.forEach((row, index) => {
      if (row.group !== group) {
        if (group) html += close();
        group = row.group;
        html += `<div class="pal-group" role="group" aria-label="${escape(group)}"><div class="pal-label"><span>${escape(group)}</span>${row.count ? `<span class="mono">${row.count}</span>` : ""}</div>${group === "Photos" ? '<div class="pal-thumbs">' : ""}`;
      }
      html += paletteRowMarkup(row, index);
    });
    body.innerHTML = html + (group ? close() : "");
  }
  icons();
  document.querySelector("#palette .pal-input")?.setAttribute("aria-activedescendant", rows.length ? `pal-${palette.active}` : "");
  document.querySelectorAll("#palette [data-pal-photo]").forEach(async (node) => {
    const row = rows[Number(node.dataset.palPhoto)];
    try {
      const result = await cachedPhoto("/v1/gallery/preview?" + new URLSearchParams({ volume: row.volume, path: row.path, hash: row.hash }));
      if (!node.isConnected || !result?.data) return;
      const img = document.createElement("img");
      img.alt = "";
      img.src = result.data;
      node.replaceChildren(img);
    } catch {
      /* A missing preview keeps the icon. */
    }
  });
}
async function runPalette() {
  if (!palette) return;
  const query = palette.query.trim();
  const serial = ++palette.serial;
  if (!query) return paintPalette(null);
  let data = null;
  try {
    data = await api(`/v1/search?${new URLSearchParams({ q: query, scope: palette.scope, limit: "6" })}`);
  } catch {
    data = { folders: [], files: [], photos: [], music: [], counts: {} };
  }
  if (!palette || palette.serial !== serial) return;
  paintPalette(data);
}
function openPalette() {
  if (!ready || $("#dialog").open) return;
  if (palette) return void document.getElementById("palette")?.close();
  const looking = document.getElementById("quicklook");
  if (looking?.open) looking.close();
  const dialog = paletteDialog();
  palette = { query: "", scope: "all", rows: [], active: 0, serial: 0, opener: document.activeElement };
  dialog.innerHTML = `<div class="pal-field">${icon("search")}<input class="pal-input" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-label="Search Arca" placeholder="Search folders, files, photos and music" autocomplete="off" spellcheck="false"><span class="tag">esc</span></div><div class="pal-scopes"><div class="segmented" role="group" aria-label="Scope">${[["all", "All"], ["files", "Files"], ["photos", "Photos"], ["music", "Music"]].map(([id, label]) => `<button type="button" data-pal-scope="${id}" class="${id === "all" ? "active" : ""}" aria-pressed="${id === "all"}">${label}</button>`).join("")}</div></div><div class="pal-body" id="pal-list" role="listbox"></div><div class="pal-foot"><span class="pal-hint"><span class="tag">↑</span><span class="tag">↓</span>Move</span><span class="pal-hint"><span class="tag">↵</span>Open</span><span class="pal-hint"><span class="tag">esc</span>Close</span><span class="pal-end">This device · ${countLabel(status.volumes.filter((v) => status.role === "hub" || v.selected).length, "folder")}</span></div>`;
  dialog.showModal();
  icons();
  dialog.querySelector(".pal-input").focus();
  paintPalette(null);
}
async function activatePalette(index) {
  const row = palette?.rows[index];
  if (!row) return;
  const query = palette.query;
  if (row.type === "recent") {
    const input = document.querySelector("#palette .pal-input");
    input.value = row.text;
    palette.query = row.text;
    palette.active = 0;
    return void runPalette();
  }
  document.getElementById("palette").close();
  if (row.type === "action") {
    if (row.name === "settings") {
      view = "settings";
      detailId = null;
      await render();
      updateShell();
    } else await handle(row.name, "");
    return;
  }
  rememberPalette(query);
  if (row.type === "folder") {
    view = "folders";
    await handle("folder-detail", row.id);
    updateShell();
    return;
  }
  await handle("activity-file", JSON.stringify({ volume: row.volume, path: row.path, rev: row.rev, deleted: false }));
}
document.addEventListener("input", (event) => {
  if (!palette || !event.target.matches?.("#palette .pal-input")) return;
  palette.query = event.target.value;
  palette.active = 0;
  clearTimeout(palette.timer);
  palette.timer = setTimeout(runPalette, event.target.value.trim() ? 120 : 0);
});
document.addEventListener("click", (event) => {
  if (!palette) return;
  const scope = event.target.closest?.("#palette [data-pal-scope]");
  if (scope) {
    palette.scope = scope.dataset.palScope;
    document.querySelectorAll("#palette [data-pal-scope]").forEach((control) => {
      const on = control === scope;
      control.classList.toggle("active", on);
      control.setAttribute("aria-pressed", String(on));
    });
    palette.active = 0;
    void runPalette();
    return;
  }
  const row = event.target.closest?.("#palette [data-pal]");
  if (row) void activatePalette(Number(row.dataset.pal));
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (!palette || !document.getElementById("palette")?.open) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = palette.rows.length;
    if (!count) return;
    palette.active = (palette.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    document.querySelectorAll("#palette [data-pal]").forEach((row, index) => {
      row.classList.toggle("pal-active", index === palette.active);
      row.setAttribute("aria-selected", String(index === palette.active));
    });
    document.querySelector(`#palette #pal-${palette.active}`)?.scrollIntoView?.({ block: "nearest" });
    document.querySelector("#palette .pal-input")?.setAttribute("aria-activedescendant", `pal-${palette.active}`);
  } else if (event.key === "Enter") {
    event.preventDefault();
    void activatePalette(palette.active);
  }
});
const TEXT_NAME = /\.(txt|md|markdown|mdx|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|sh|bash|zsh|sql|env|gitignore|arcaignore)$/i;
function previewKind(name) {
  return /\.(jpe?g|png|webp|gif|avif|hei[cf])$/i.test(name)
    ? "image"
    : /\.(mp4|mov|m4v|webm)$/i.test(name)
      ? "video"
      : /\.(mp3|m4a|flac|wav|ogg|opus|aac|aiff?)$/i.test(name)
        ? "audio"
        : TEXT_NAME.test(name)
          ? "text"
          : "none";
}
const previewQuery = (volume, path, hash, large) =>
  new URLSearchParams({ volume, path, hash, ...(large ? { size: "large" } : {}) });
async function loadPreview(volume, path, hash, large = true) {
  const kind = previewKind(path);
  if (kind === "image" || kind === "video") {
    const result = await cachedPhoto(`/v1/gallery/preview?${previewQuery(volume, path, hash, large && kind === "image")}`);
    return result?.data ? { kind, data: result.data } : { kind: "none" };
  }
  if (kind === "text") {
    const result = await api(`/v1/file-preview?${previewQuery(volume, path, hash)}`);
    return result.kind === "text" ? { kind, lines: result.lines, truncated: result.truncated } : { kind: "none" };
  }
  return { kind };
}
function previewBody(preview, name) {
  if (preview.data) return `<img alt="${escape(name)}" src="${escape(preview.data)}">`;
  if (preview.lines)
    return `<pre class="ql-text">${escape(preview.lines.join("\n"))}${preview.truncated ? "\n…" : ""}</pre>`;
  return `<span class="ql-icon">${icon(fileIcon(name))}</span>`;
}
let quick = null;
function quickDialog() {
  let dialog = document.getElementById("quicklook");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "quicklook";
    dialog.className = "quicklook";
    dialog.addEventListener("close", () => {
      const row = quick?.rows[quick.index]?.el;
      quick = null;
      if (row?.isConnected) row.focus();
    });
    document.body.append(dialog);
  }
  return dialog;
}
async function showQuick(index) {
  if (!quick) return;
  quick.index = index;
  const row = quick.rows[index];
  const name = row.name;
  const dialog = quickDialog();
  const id = JSON.parse(row.id);
  const kind = previewKind(name);
  const serial = (quick.serial = (quick.serial || 0) + 1);
  const meta = [bytes(row.size || 0), (name.split(".").pop() || "").toUpperCase()].filter(Boolean).map((x) => `<span>${escape(x)}</span>`).join("");
  dialog.innerHTML = `<div class="ql-bar"><div class="tile">${icon(fileIcon(name))}</div><div class="ql-title"><strong>${escape(name)}</strong><p>${index + 1} of ${quick.rows.length} in this folder</p></div><button type="button" class="ghost icon-button" data-ql="prev" aria-label="Previous file"${index === 0 ? " disabled" : ""}>${icon("chevron-left")}</button><button type="button" class="ghost icon-button" data-ql="next" aria-label="Next file"${index === quick.rows.length - 1 ? " disabled" : ""}>${icon("chevron-right")}</button><button type="button" class="secondary small-button" data-ql="open">Open</button><button type="button" class="ghost icon-button" data-ql="close" aria-label="Close">${icon("x")}</button></div><div class="ql-stage" aria-busy="${kind !== "audio" && kind !== "none"}"><span class="ql-icon">${icon(fileIcon(name))}</span></div><div class="ql-meta">${meta}</div><div class="ql-foot"><span class="ql-hint"><span class="tag">←</span><span class="tag">→</span>Previous and next</span><span class="ql-hint"><span class="tag">Space</span>Close</span><span class="ql-hint"><span class="tag">↵</span>Open file</span></div>`;
  dialog.setAttribute("aria-label", `Quick Look ${name}`);
  if (!dialog.open) {
    dialog.showModal();
    dialog.tabIndex = -1;
    dialog.focus();
  }
  icons();
  if (kind === "none" || kind === "audio" || !row.hash) {
    dialog.querySelector(".ql-stage").setAttribute("aria-busy", "false");
    return;
  }
  try {
    const preview = await loadPreview(id.volume, id.path, row.hash);
    if (!quick || quick.serial !== serial) return;
    const stage = dialog.querySelector(".ql-stage");
    stage.innerHTML = previewBody(preview, name);
    stage.setAttribute("aria-busy", "false");
    icons();
  } catch {
    if (quick?.serial === serial) dialog.querySelector(".ql-stage")?.setAttribute("aria-busy", "false");
  }
}
function openQuickLook(row) {
  const nodes = [...document.querySelectorAll('#content .browser-file-row[data-action="activity-file"]')];
  const index = nodes.indexOf(row);
  if (index < 0) return;
  const rows = nodes.map((el) => ({ el, id: el.dataset.id, name: el.dataset.name, hash: el.dataset.hash, size: Number(el.dataset.size) || 0 }));
  quick = { rows, index, serial: 0 };
  void showQuick(index);
}
document.addEventListener("click", (event) => {
  const control = event.target.closest?.("#quicklook [data-ql]");
  if (!control || !quick) return;
  const dialog = document.getElementById("quicklook");
  const action = control.dataset.ql;
  if (action === "close") dialog.close();
  else if (action === "prev" && quick.index > 0) void showQuick(quick.index - 1);
  else if (action === "next" && quick.index < quick.rows.length - 1) void showQuick(quick.index + 1);
  else if (action === "open") {
    const row = quick.rows[quick.index];
    dialog.close();
    void handle("activity-file", row.id);
  }
});
document.addEventListener("keydown", (event) => {
  const dialog = document.getElementById("quicklook");
  if (!quick || !dialog?.open || palette) return;
  if (event.key === "ArrowLeft" && quick.index > 0) {
    event.preventDefault();
    void showQuick(quick.index - 1);
  } else if (event.key === "ArrowRight" && quick.index < quick.rows.length - 1) {
    event.preventDefault();
    void showQuick(quick.index + 1);
  } else if (event.key === " ") {
    event.preventDefault();
    if (!event.repeat) dialog.close();
  } else if (event.key === "Enter" && !event.target.closest?.("button")) {
    event.preventDefault();
    const row = quick.rows[quick.index];
    dialog.close();
    void handle("activity-file", row.id);
  }
});
async function hydrateFileHeroes() {
  for (const hero of document.querySelectorAll(".file-hero:not([data-loaded])")) {
    hero.dataset.loaded = "true";
    try {
      const preview = await loadPreview(hero.dataset.volume, hero.dataset.path, hero.dataset.hash, false);
      if (!hero.isConnected || preview.kind === "none") {
        if (hero.isConnected) hero.remove();
        continue;
      }
      hero.querySelector(".file-hero-stage").innerHTML = previewBody(preview, hero.dataset.path.split("/").pop());
      hero.removeAttribute("aria-busy");
      icons();
    } catch {
      hero.remove();
    }
  }
}
function rowPreview(row, fallback, historical = false) {
  if (
    row.directory ||
    row.deleted ||
    !row.hash ||
    !/\.(jpe?g|png|webp|gif|avif|hei[cf]|mp4|mov|m4v|webm)$/i.test(
      row.path || "",
    )
  )
    return icon(fallback);
  const query = new URLSearchParams({
    volume: row.volume,
    path: row.path,
    hash: row.hash,
    ...(historical ? { rev: String(row.rev) } : {}),
  });
  return `<span class="row-preview" data-row-preview="${escape(query.toString())}">${icon(fallback)}${historical ? `<span class="row-preview-status">${icon(fallback)}</span>` : ""}</span>`;
}
const HUB_PREVIEW_WAIT = /took too long|Hub unavailable/i;
let rowPreviewObserver;
const observedRowPreviews = new Set();
let rowPreviewWorkers = 0;
const rowPreviewQueue = [];
function mountRowPreviews() {
  for (const el of observedRowPreviews)
    if (!el.isConnected) {
      rowPreviewObserver?.unobserve(el);
      observedRowPreviews.delete(el);
    }
  const drain = () => {
    while (rowPreviewWorkers < 3 && rowPreviewQueue.length) {
      const el = rowPreviewQueue.shift();
      if (!el.isConnected) continue;
      rowPreviewWorkers++;
      cachedPhoto("/v1/gallery/preview?" + el.dataset.rowPreview)
        .then((value) => {
          if (!el.isConnected || !value.data) return;
          const img = new Image();
          img.alt = "";
          img.onload = () => {
            if (el.isConnected) el.prepend(img);
          };
          img.src = value.data;
        })
        .catch((error) => {
          const state = el.querySelector(".row-preview-status");
          const message = error?.message || "";
          if (!state || !el.isConnected || !HUB_PREVIEW_WAIT.test(message))
            return;
          state.innerHTML = icon("clock");
          state.dataset.tooltip = message;
          state.setAttribute("role", "img");
          state.setAttribute("aria-label", message);
          el.classList.add("is-failed");
          icons();
        })
        .finally(() => {
          rowPreviewWorkers--;
          drain();
        });
    }
  };
  if (!rowPreviewObserver && typeof IntersectionObserver !== "undefined")
    rowPreviewObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            rowPreviewObserver.unobserve(entry.target);
            rowPreviewQueue.push(entry.target);
          }
        drain();
      },
      { rootMargin: "100px" },
    );
  for (const el of document.querySelectorAll(
    "[data-row-preview]:not([data-observed])",
  )) {
    el.dataset.observed = "true";
    if (rowPreviewObserver) {
      observedRowPreviews.add(el);
      rowPreviewObserver.observe(el);
    }
  }
}
function icons() {
  mountRowPreviews();
  if (typeof hydrateFileHeroes === "function") void hydrateFileHeroes();
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
const hubOnlyActions = new Set([
  "add",
  "select",
  "restore",
  "review-conflict",
  "disconnect-hub",
]);
function hubOffline() {
  return status?.role === "replica" && !!status.hubUnavailable;
}
function button(label, action, id = "", cls = "secondary", symbol = "") {
  const waiting = hubOnlyActions.has(action) && hubOffline();
  return `<button type="button" class="${cls}" data-action="${action}" data-id="${escape(id)}"${waiting ? ` disabled title="${HUB_ONLY_REASON}"` : ""}>${symbol ? icon(symbol) : ""}${label}</button>`;
}
function roleTag(role) {
  return !role || role === "replica" ? "" : `<span class="tag">${escape(role)}</span>`;
}
function copyTag(m, v) {
  const label =
    m.machineId === status.id
      ? "This device"
      : m.revoked
        ? "Access revoked"
        : m.albumFolderIds?.includes(v.id)
          ? "Album source"
          : m.isHub
            ? "Hub"
            : "";
  return label
    ? `<span class="tag ${m.machineId === status.id ? "self" : m.isHub ? "hub" : ""}">${label}</span>`
    : "";
}
function selectFolderButton(id) {
  return button("Start syncing", "add", id, "secondary small-button", "refresh-cw");
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
function historyEmpty() {
  if (historyFilter === "conflicts")
    return empty("No conflicts", "Clear Conflicts to see every change.", "", "triangle-alert");
  if (historyFilter === "deleted")
    return empty("No deleted files", "Clear Deleted to see every change.", "", "trash-2");
  if (historyVolume)
    return empty("No changes in this folder", "Set Shared folder to All to see every change.", "", "history");
  return empty("No history yet", "Changes to your files appear here.", "", "history");
}
function empty(heading, text, control = "", symbol = "folder-open") {
  return `<div class="empty">${icon(symbol)}<h2>${heading}</h2>${text ? `<p>${text}</p>` : ""}${control}</div>`;
}
const section = (name, body) =>
  `<section><div class="section-label">${name}</div>${body}</section>`;
const setting = (name, description, control = "", leading = "") =>
  `<div class="setting-row">${leading}<div class="row-main"><strong>${name}</strong><p>${description}</p></div>${control}</div>`;
const unboundedRequests = new Set([
  "/v1/unselect",
  "/v1/move-folder",
  "/v1/promote",
  "/v1/destroy-replica",
  "/v1/destroy-hub",
]);
function browserTimeout(route, body) {
  if (body !== undefined) return unboundedRequests.has(route) ? 0 : 30000;
  if (route.startsWith("/v1/events")) return 25000;
  return /^\/v1\/(gallery\/|discovery)/.test(route) ? 65000 : 20000;
}
function transportError(body) {
  return Object.assign(
    new Error(
      body === undefined
        ? "Cannot reach this device. Check your connection and retry."
        : "Connection interrupted. The result is unknown. Refresh before trying again.",
    ),
    { transportError: true, readOnly: body === undefined },
  );
}
async function browserRequest(route, body) {
  const limit = browserTimeout(route, body);
  let response, data, unreadable;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = limit ? setTimeout(() => controller.abort(), limit) : null;
    try {
      response = await fetch(route, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      try {
        data = await response.json();
        unreadable = false;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        unreadable = true;
      }
      break;
    } catch {
      if (body === undefined && attempt === 0 && !controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw transportError(body);
    } finally {
      clearTimeout(timer);
    }
  }
  if (
    [502, 503, 504].includes(response.status) &&
    (unreadable || body === undefined)
  )
    throw transportError(body);
  if (unreadable)
    throw new Error("The server returned an unreadable response. Try again.");
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
let brandShowTimer = null,
  brandHideTimer = null,
  brandShownAt = 0;
function updateBrandActivity() {
  const mark = $(".sidebar .brand-mark");
  if (!mark) return;
  const active =
    activeRequests > 0 ||
    busy ||
    document.body.classList.contains("view-loading") ||
    (!daemonStopped &&
      !status?.hubUnavailable &&
      ["syncing", "scanning"].includes(status?.phase));
  const paint = (visible) => {
    if (!mark.isConnected) return;
    mark.classList.toggle("is-busy", visible);
    mark.setAttribute("aria-label", visible ? "Arca: updating" : "Arca");
    mark.setAttribute("aria-busy", String(visible));
    const indicator = mark.querySelector(".brand-busy");
    if (visible && indicator && !indicator.firstChild)
      indicator.innerHTML = busyIcon();
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
      if (!brandHideTimer)
        brandHideTimer = setTimeout(
          () => {
            brandHideTimer = null;
            paint(false);
          },
          Math.max(0, 500 - (Date.now() - brandShownAt)),
        );
    } else paint(false);
  }
}
const api = (route, body) => {
  const cacheKey = folderPageKey(route),
    cacheEpoch = folderCacheEpoch;
  const showActivity =
    body !== undefined || !["/v1/status", "/v1/web-approvals"].includes(route);
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
      if (route === "/v1/gallery/delete")
        for (const row of value.rows || []) rememberGalleryDeletion(row);
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
        recentSaved.clear();
        recentFailed.clear();
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
  daemonStopped = false,
  daemonProbe = null,
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
  folderPageCount = 1,
  historyRows = [],
  historyNext = null,
  historyDays = null,
  awayNotice = null,
  historyVersions = [],
  historyLocal = null,
  historyOffline = false,
  fileRevision = null,
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
          `<div class="copy-row">${icon(m.isHub ? "server" : /android|ios/.test(m.platform) ? "smartphone" : "monitor")}<strong>${escape(m.name)}</strong>${copyTag(m, v)}</div>`,
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
      ? '<p class="hint">Some devices have not reported their folders yet.</p>'
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
      copiesUnavailable = !!data.offline && !!data.savedAt;
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
document.body.classList.toggle(
  "mac-native",
  native && /Mac/i.test(navigator.platform || navigator.userAgent),
);
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
function notice(message, error = false, { hubOnly = false, ...options } = {}) {
  const item = error
    ? errorNotice(message, { hubName: status?.hubName || "your hub", hubOnly })
    : { kind: "info", title: message };
  return noticeStore.push({ ...item, ...options });
}
function hubOnlyFailure(error) {
  return /Hub unavailable\. Try again when it is reachable/i.test(
    error?.message || "",
  );
}
function hubOnlyBlocked() {
  const message = "Hub unavailable. Try again when it is reachable.";
  if ($("#dialog").open) {
    $("#dialog-error").innerHTML = noticeMarkup({
      ...errorNotice(message, {
        hubName: status?.hubName || "your hub",
        hubOnly: true,
      }),
      id: "dialog-error",
      action: null,
    });
    $("#dialog-error").hidden = false;
  } else notice(message, true, { hubOnly: true, action: null });
}
function syncHubOnlyControls() {
  const waiting = hubOffline();
  const selector = [...hubOnlyActions]
    .map((name) => `button[data-action="${name}"]`)
    .concat(".photo-selection-delete", ".photo-delete")
    .join(",");
  for (const control of document.querySelectorAll(selector)) {
    if (pendingControls.has(control)) continue;
    control.disabled = waiting;
    if (waiting) control.title = HUB_ONLY_REASON;
    else if (control.title === HUB_ONLY_REASON) control.removeAttribute("title");
  }
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
    if (daemonUnavailable(e)) showDaemonStopped();
    if ($("#dialog").open) {
      $("#dialog-error").innerHTML = noticeMarkup({
        ...errorNotice(message, {
          hubName: status?.hubName || "your hub",
          hubOnly: hubOnlyFailure(e),
        }),
        id: "dialog-error",
        action: null,
      });
      $("#dialog-error").hidden = false;
    } else if (!daemonUnavailable(e)) {
      notice(message, true, {
        id: e.transportError && e.readOnly ? "connection" : "action",
        action: e.transportError && e.readOnly ? "refresh" : null,
        hubOnly: hubOnlyFailure(e),
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
  if (status.phase === "paused") return ["Paused", "wa", "pause"];
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
  native && status?.platform === "darwin" ? "this Mac" : "this device";
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
  if (nav) nav.innerHTML = icon("monitor-smartphone") + "Devices";

  $("#managed-role").textContent = status.role === "hub" ? "Hub" : "";
  $("#managed-role").hidden = status.role !== "hub";
  $("#managed-name").textContent = status.name;
  const states = {
    idle: ["Up to date", "ok", "circle-check"],
    paused: ["Paused", "wa", "pause"],
    syncing: ["Syncing", "sy", "busy"],
    error: ["Needs attention", "er", "circle-alert"],
    unlinked: status.hub
      ? ["Connected", "id", "link"]
      : ["Disconnected", "wa", "unplug"],
    "needs-folder": ["No shared folders", "id", "folder"],
  };
  const conflicts = status.volumes.reduce((n, v) => n + v.conflicts, 0);
  const [label, color, symbol] = (daemonStopped
    ? ["Service stopped", "er", "power"]
    : status.hubUnavailable && status.phase !== "paused"
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
      ? "Local files are kept on this device"
      : status.lastSync
        ? `Last sync ${relative(status.lastSync)}`
        : "Not synced yet";
  $("#last-sync").hidden = label === "Up to date";
  const backup = $("#backup-summary");
  const hubBackups = (status.devices || []).filter(
    (device) => !device.revoked && device.backup_enabled,
  );
  const reported = hubBackups.filter((device) => device.backup_updated).length;
  const backupLabel =
    status.role === "hub"
      ? reported
        ? `${reported} ${reported === 1 ? "backup" : "backups"} reported`
        : hubBackups.length
          ? "Backup pending"
          : "No backup reported"
      : status.backup?.enabled
        ? status.backup.progress
          ? "Backing up…"
          : status.backup.waiting
            ? "Full backup waiting for hub"
            : status.backup.error
              ? "Full backup needs attention"
              : status.backup.lastSync
                ? "Full backup enabled"
                : "Full backup pending"
        : "Full backup off";
  backup.hidden = status.role !== "hub" && !status.hub;
  backup.dataset.action =
    status.role === "hub" ? "machines" : "backup-settings";
  backup.innerHTML =
    icon(
      status.role === "hub"
        ? reported
          ? "shield-check"
          : "shield"
        : status.backup?.enabled
          ? "shield-check"
          : "shield",
    ) + `<span>${backupLabel}</span>`;
  backup.title =
    status.role === "hub"
      ? "View backup reports from your devices"
      : "Manage this device’s additional full copy of the hub and its history";
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
  if (musicPlayer && !musicPlayable()) stopMusic();
  syncHubOnlyControls();
  if (daemonStopped) daemonRecovered();
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
          : `${countLabel(volume.files || 0, "file")} · ${bytes(volume.bytes)}`);
      const lead = row.querySelector(".home-lead");
      if (!lead) continue;
      let ring = lead.querySelector(".home-ring");
      const determinate = p && Number.isFinite(p.filesTotal) && p.filesTotal > 0;
      if (!determinate) {
        if (!volume.conflicts) ring?.remove();
        else ring?.querySelector(".home-ring-fill")?.removeAttribute("stroke-dasharray");
        lead.removeAttribute("aria-label");
        lead.removeAttribute("role");
        continue;
      }
      if (!ring) {
        lead.insertAdjacentHTML(
          "afterbegin",
          '<svg class="home-ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="home-ring-track" cx="24" cy="24" r="22" /><circle class="home-ring-fill" cx="24" cy="24" r="22" pathLength="100" /></svg>',
        );
        ring = lead.querySelector(".home-ring");
      }
      lead.setAttribute("role", "status");
      lead.setAttribute("aria-label", ringLabel(p));
      const fill = ring.querySelector(".home-ring-fill");
      fill.setAttribute(
        "stroke-dasharray",
        `${Math.min(100, Math.round((100 * (p.filesDone || 0)) / p.filesTotal))} 100`,
      );
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
const retainedFor = (span) =>
  `Older versions of every file in this folder stay restorable for ${span} after a change or deletion; after that, only the current files remain.`;
const folderRetentionChoices = [
  {
    id: "off",
    label: "Off",
    summary: "Off",
    effect:
      "Only the current files are kept: older versions of every file in this folder are removed.",
  },
  { id: "1d", label: "1 day", summary: "On · 1 day", effect: retainedFor("a day") },
  { id: "1w", label: "1 week", summary: "On · 1 week", effect: retainedFor("a week") },
  { id: "1m", label: "30 days", summary: "On · 30 days", effect: retainedFor("30 days") },
  {
    id: "forever",
    label: "Forever",
    summary: "Forever",
    effect: "Every older version of every file in this folder is kept from now on.",
  },
];
function folderRetentionMode(volume) {
  return (
    (status.role === "hub"
      ? status.folderRetention?.[volume.id]
      : (catalog.find((row) => row.id === volume.id)?.historyRetention ??
        volume.historyRetention)) || "1m"
  );
}
function folderRetentionSummary(volume) {
  const mode = folderRetentionMode(volume);
  const label =
    folderRetentionChoices.find((choice) => choice.id === mode)?.summary ||
    "Unknown";
  return `<div class="stat folder-history-status"><span>Version history</span><strong>${escape(label)}</strong><p>${mode === "off" ? "Current files only" : "Older versions kept"}</p></div>`;
}
function folderRetentionPanel(volume) {
  const mode = folderRetentionMode(volume);
  const effect = folderRetentionChoices.find((choice) => choice.id === mode)?.effect;
  return `<div class="panel"><h3>Keep older versions for</h3><div id="folder-retention" data-volume="${escape(volume.id)}">${segmented(
    "Version history retention",
    folderRetentionChoices.map((choice) => ({
      label: choice.label,
      action: "folder-retention",
      id: choice.id,
      active: mode === choice.id,
    })),
    "segmented-fill",
  )}</div>${effect ? `<p>${effect}</p>` : ""}</div>`;
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
          "Remove older versions?",
          `${preview.remove} older versions will be permanently removed. Current files are kept.`,
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
  const linked =
    !daemonStopped && (status.role === "hub" || Boolean(status.hub));
  const paused = status.phase === "paused";
  const syncing =
    !status.hubUnavailable && ["syncing", "scanning"].includes(status.phase);
  const signature = `${linked}:${paused}:${syncing}`;
  if (root.dataset.state === signature) return;
  root.dataset.state = signature;
  root.hidden = !linked;
  const pauseLabel = paused ? "Resume sync" : "Pause sync";
  root.innerHTML = !linked
    ? ""
    : iconAction(pauseLabel, "pause", paused ? "play" : "pause") +
      (syncing ? "" : iconAction("Sync now", "sync", "refresh-cw", paused));
}
function progressLabel(p) {
  const sending = p.stage === "upload" || p.direction === "upload";
  const verb = sending ? "sent" : "checked";
  const count = Number.isFinite(p.filesTotal)
    ? `${(p.filesDone || 0).toLocaleString("en")} / ${countLabel(p.filesTotal, "file")} ${verb}`
    : `${countLabel(p.filesDone || 0, "file")} ${verb}`;
  const size =
    p.sizeTotal > 0 ? ` · ${bytes(p.sizeDone || 0)} / ${bytes(p.sizeTotal)}` : "";
  const transfer =
    !size && p.bytesTotal > 0
      ? ` · ${bytes(p.bytesDone)} / ${bytes(p.bytesTotal)}`
      : "";
  return `${count}${size} · ${p.path || (sending ? "Preparing upload" : "Checking hub files")}${transfer}`;
}
let homeData = { arrivals: [], at: 0 };
const baseName = (path) => path.split("/").pop();
function homeStrip() {
  if (!homeData.arrivals.length || (status.role !== "hub" && !status.hub)) return "";
  return section(
    "Just arrived",
    `<div class="home-arrivals">${homeData.arrivals
      .map(
        (row) =>
          `<button type="button" class="home-arrival" data-action="activity-file" data-id="${escape(JSON.stringify({ volume: row.volume, path: row.path, rev: row.rev, deleted: false }))}"><span class="tile">${icon(fileIcon(row.path))}</span><span class="home-arrival-text"><strong>${escape(baseName(row.path))}</strong><span>${escape(authorName(row.author))} · ${escape(relative(row.created))}</span></span></button>`,
      )
      .join("")}</div>`,
  );
}
const ringLabel = (p) =>
  `${p.stage === "upload" || p.direction === "upload" ? "Files sent" : "Files checked"}: ${(p.filesDone || 0).toLocaleString("en")} of ${p.filesTotal.toLocaleString("en")}`;
function homeLead(v, state, p) {
  const busy = state[2] === "busy";
  const ring =
    p?.filesTotal > 0
      ? Math.min(100, Math.round((100 * (Number(p.filesDone) || 0)) / p.filesTotal))
      : null;
  const conflict = Boolean(v.conflicts);
  const tile = `<div class="tile large"${busy ? ` role="status" aria-label="${escape(state[0])}"` : ""}>${busy ? busyIcon() : icon(folderSymbol(v))}</div>`;
  const svg =
    ring !== null || conflict
      ? `<svg class="home-ring" viewBox="0 0 48 48" aria-hidden="true">${conflict ? "" : '<circle class="home-ring-track" cx="24" cy="24" r="22" />'}<circle class="home-ring-fill" cx="24" cy="24" r="22" pathLength="100"${conflict ? "" : ` stroke-dasharray="${ring} 100"`} /></svg>`
      : "";
  return `<div class="home-lead${conflict ? " home-conflict" : ""}"${ring !== null ? ` role="status" aria-label="${escape(ringLabel(p))}"` : ""}>${svg}${tile}</div>`;
}
let homeHub = "";
async function loadHome(serial) {
  const hub = status.hubId || status.id;
  if (hub !== homeHub) {
    homeHub = hub;
    homeData = { arrivals: [], at: 0 };
  }
  if (Date.now() - homeData.at < 15000) return;
  const ids = status.volumes.filter((v) => status.role === "hub" || v.selected).map((v) => v.id);
  if (!ids.length) return;
  homeData.at = Date.now();
  const [activity] = await Promise.allSettled([api("/v1/activity?limit=50&filter=revisions")]);
  if (hub !== (status.hubId || status.id)) return;
  const rows = activity.status === "fulfilled" && Array.isArray(activity.value?.versions) ? activity.value.versions : [];
  const next = {
    arrivals: rows.filter((r) => !r.deleted).slice(0, 3).map(({ volume, path, rev, created, author }) => ({ volume, path, rev, created, author })),
    at: Date.now(),
  };
  const changed = JSON.stringify(next.arrivals) !== JSON.stringify(homeData.arrivals);
  homeData = next;
  if (changed && view === "folders" && !detailId && !$("#dialog").open) await renderView(false);
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
    ? Number.isFinite(v.files)
      ? `${countLabel(v.files, "file")} · ${bytes(v.bytes)}`
      : "Not counted yet"
    : `${countLabel(v.files, "file")} · ${bytes(v.bytes)}`;
  if (p) meta = escape(progressLabel(p));
  if (v.sync?.error || v.policyError)
    meta = escape(v.sync?.error || v.policyError);
  const lead = available
    ? `<div class="tile"${state[2] === "busy" ? ` role="status" aria-label="${state[0]}"` : ""}>${state[2] === "busy" ? busyIcon() : icon(folderSymbol(v))}</div>`
    : homeLead(v, state, p);
  return `<article class="folder-card ${available ? "unselected" : ""}" ${available ? "" : `data-action="folder-detail" data-id="${escape(v.id)}" tabindex="0" role="button" aria-label="Open ${escape(v.name)} details"`}>${lead}<div class="row-main"><strong>${escape(v.name)}</strong><p class="meta">${meta}</p></div>${available ? selectFolderButton(v.id) : `${problemAction || (v.conflicts ? button("Review", "folder-conflicts", v.id, "secondary small-button") : "")}${state[2] === "busy" || ["Up to date", "Offline"].includes(state[0]) ? "" : pill(...state)}${icon("chevron-right")}`}</article>`;
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
function tokenPixels(token, fallback) {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(token),
    ) || fallback
  );
}
function motionDuration(token) {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(token),
    ) || 0
  );
}
const reducedMotion = () =>
  Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
const MOTION_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const ROW_SELECTOR =
  "#content :is(.folder-card, .history-row, .browser-file-row)[data-id], #content .device-row[data-device]";
function staggerRows() {
  if (reducedMotion()) return;
  const enter = motionDuration("--motion-enter");
  const step = motionDuration("--motion-stagger");
  const rise = tokenPixels("--motion-distance", 8);
  [...document.querySelectorAll(ROW_SELECTOR)].slice(0, 6).forEach((row, index) =>
    row.animate?.(
      [
        { opacity: 0, transform: `translateY(${rise}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: enter, delay: index * step, easing: MOTION_EASE, fill: "backwards" },
    ),
  );
}
function flip(element, from, { uniform = false } = {}) {
  if (!element || !from || reducedMotion()) return;
  const to = element.getBoundingClientRect();
  if (!to.width || !to.height || !from.width || !from.height) return;
  if (
    from.right <= 0 ||
    from.bottom <= 0 ||
    from.left >= window.innerWidth ||
    from.top >= window.innerHeight
  )
    return;
  const scaleX = from.width / to.width;
  const scaleY = from.height / to.height;
  const scale = uniform ? `scale(${Math.min(scaleX, scaleY)})` : `scale(${scaleX}, ${scaleY})`;
  const shift = uniform
    ? `translate(${from.left + from.width / 2 - to.left - to.width / 2}px, ${from.top + from.height / 2 - to.top - to.height / 2}px)`
    : `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
  element.animate?.(
    [
      { transformOrigin: uniform ? "center" : "top left", transform: `${shift} ${scale}` },
      { transformOrigin: uniform ? "center" : "top left", transform: "none" },
    ],
    { duration: motionDuration("--motion-shared"), easing: MOTION_EASE },
  );
}
const rowKey = (row) => row.dataset.id || row.dataset.device;
let notePending = false;
const settleTimers = new WeakMap();
let seenRows = { route: "", keys: new Set() };
function noteRows() {
  const route = routeURL();
  const rows = [...document.querySelectorAll(ROW_SELECTOR)];
  const keys = new Set(rows.map(rowKey));
  if (!keys.size && seenRows.route === route) return;
  if (seenRows.route === route && seenRows.keys.size && !document.hidden && !reducedMotion()) {
    const lastSeen = rows.findLastIndex((row) => seenRows.keys.has(rowKey(row)));
    const fresh = rows.filter(
      (row, index) =>
        !seenRows.keys.has(rowKey(row)) &&
        (index < lastSeen || row.matches(".folder-card, .device-row")),
    );
    if (fresh.length && fresh.length <= 6)
      for (const row of fresh) {
        row.classList.add("row-arrived");
        row.animate?.(
          [
            { opacity: 0, transform: `translateY(${tokenPixels("--motion-distance", 8)}px)` },
            { opacity: 1, transform: "none" },
          ],
          { duration: motionDuration("--motion-enter"), easing: MOTION_EASE },
        );
        clearTimeout(settleTimers.get(row));
        settleTimers.set(
          row,
          setTimeout(() => row.classList.remove("row-arrived"), motionDuration("--motion-settle")),
        );
      }
  }
  seenRows = { route, keys };
}
if (typeof MutationObserver === "function" && document.querySelector("#content"))
  new MutationObserver(() => {
    if (notePending) return;
    notePending = true;
    const run = () => {
      notePending = false;
      noteRows();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }).observe(
    document.querySelector("#content"),
    { childList: true, subtree: true },
  );
async function render({ refreshStatus = false } = {}) {
  if (daemonStopped) return renderDaemonStopped();
  if (view !== "devices") pickedDevice = "";
  placeMusic();
  if (
    folderTab === "gallery" &&
    galleryView?.root?.isConnected &&
    galleryView.items.length
  ) {
    galleryReturn = {
      volume: galleryView.volume,
      items: galleryView.items,
      next: galleryView.next,
      previous: galleryView.previous,
      range: galleryView.range,
      dates: galleryView.dates,
      undated: galleryView.undated,
      month: galleryView.month,
      days: galleryView.days,
      scroll: galleryView.root.closest(".page")?.scrollTop || 0,
    };
  }
  galleryView?.observer?.disconnect();
  galleryView?.moreObserver?.disconnect();
  galleryView?.newerObserver?.disconnect();
  galleryView?.cleanup?.();
  const loading = ++viewLoadSerial;
  const route = routeURL();
  if (location.hash !== route) window.history.pushState(null, "", route);
  document.body.classList.add("view-loading");
  updateBrandActivity();
  $("#content").setAttribute("aria-busy", "true");
  try {
    const painted = status;
    const page = renderView(true, undefined, refreshStatus);
    const cascade = animatedRoute !== route;
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
    if (cascade && serial === renderSerial) staggerRows();
    const failed = results.find((result) => result.status === "rejected");
    // The view just painted is current; the next poll repaints only if status really changes.
    if (!failed && serial === renderSerial && status === painted)
      lastSignature = viewRefreshSignature(status, view, detailId);
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
    else html += homeStrip();
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
              ? "Share an existing or new folder. Other devices choose where to sync it."
              : `Pick folders from your hub${status.hub && available.length ? ", or start syncing one below" : ""}. Full copies are kept on disk and work offline.`,
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
    if (status.role === "hub" || status.hub) void loadHome(serial);
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
  return `<div data-action="${action}" data-id="${escape(target)}" tabindex="0" role="button"${action === "review-conflict" && hubOffline() ? ` aria-disabled="true" title="${HUB_ONLY_REASON}"` : ""} aria-label="${escape(`${action === "review-conflict" ? "Review conflict for" : "View history for"} ${v.path}`)}" class="history-row ${compact ? "compact" : ""} ${deleted ? "deleted" : conflict && !v.resolved ? "conflict" : ""}">${rowPreview(v, deleted ? "trash-2" : conflict ? "triangle-alert" : "git-commit-horizontal", true)}<div><strong>${escape(v.path)}</strong><p>${deleted ? "Deleted · recoverable" : conflict ? (v.resolved ? "Conflict resolved · copy kept" : "Conflict copy retained") : `${bytes(v.size)}`}</p></div>${compact ? "" : `<span class="history-folder">${escape(v.folder || status.volumes.find((x) => x.id === v.volume)?.name || "")}</span>`}<span class="mono revision">rev ${v.rev}</span><span class="row-time">${compact ? relative(v.created) : clockTime(v.created)}</span><div class="row-actions">${icon("chevron-right")}</div></div>`;
}
function fileHistoryHeader() {
  const volume = status.volumes.find((v) => v.id === historyVolume);
  const current = historyVersions[0];
  const filename = historyPath.split("/").at(-1);
  const available = current && !current.deleted && !current.directory;
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
        : available && !native && volume?.selected && historyLocal?.hash
          ? `<a class="secondary" href="/v1/gallery/download?${escape(new URLSearchParams({ volume: historyVolume, path: historyPath, hash: historyLocal.hash }))}" download="${escape(filename)}">${icon("download")}Download file</a>`
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
          "triangle-alert",
        )
      : "";
  const finder =
    available && native && volume?.path
      ? button(
          status.platform === "darwin" ? "Show in Finder" : "Show in folder",
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

function currentFileRev() {
  const opened =
    fileRevision?.volume === historyVolume && fileRevision.path === historyPath
      ? fileRevision.rev
      : null;
  const latest = historyVersions[0]?.rev ?? null;
  return opened === null && latest === null
    ? undefined
    : Math.max(opened ?? 0, latest ?? 0);
}
function fileHistorySummary() {
  const current = historyVersions[0];
  if (current && !current.created)
    return `<div class="file-history-summary"><p class="hint">Local copy · ${bytes(current.size)} · hub history unavailable</p></div>`;
  const available = current && !current.deleted;
  const hero =
    available && current.hash && previewKind(historyPath) !== "none" && previewKind(historyPath) !== "audio"
      ? `<div class="file-hero" aria-busy="true" data-volume="${escape(historyVolume)}" data-path="${escape(historyPath)}" data-hash="${escape(current.hash)}"><div class="file-hero-stage"><span class="ql-icon">${icon(fileIcon(historyPath))}</span></div></div>`
      : "";
  return `<div class="file-history-summary">${hero}<div class="stats"><div class="stat"><span>Status on hub</span><strong>${current ? (current.deleted ? "Deleted" : current.resolved ? "Resolved" : "Available") : "Unknown"}</strong></div><div class="stat"><span>File size</span><strong>${available ? bytes(current.size) : "—"}</strong><p>Latest accepted version</p></div><div class="stat"><span>Latest version</span><strong class="mono">${current ? `rev ${current.rev}` : "—"}</strong><p>${current ? escape(authorName(current.author)) : historyOffline ? "No saved versions" : "No retained versions"}</p></div><div class="stat"><span>Last changed</span><strong>${current ? date(current.created) : "—"}</strong><p>Accepted by the hub</p></div></div></div>`;
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
let galleryReturn = null;
let galleryView = null,
  folderViewId = null,
  folderReturn = { tab: "files", scroll: 0 };
const GALLERY_HERO_AT = 8;
const GALLERY_QUIET_BELOW = 4;
const GALLERY_SIDE_TILES = 4;
const galleryDayHeading = (key) => {
  const d = new Date(`${key}T12:00:00`);
  const part = (options) => d.toLocaleDateString("en", options);
  return `${part({ weekday: "long" })} ${d.getDate()} ${part({ month: "long" })}`;
};
const galleryRange = (days) => {
  const sorted = [...days].sort();
  const first = new Date(`${sorted[0]}T12:00:00`);
  const last = new Date(`${sorted.at(-1)}T12:00:00`);
  return `${first.getDate()}–${last.getDate()} ${last.toLocaleDateString("en", { month: "long" })}`;
};
function mountGallery(volume) {
  galleryView?.observer?.disconnect();
  galleryView?.moreObserver?.disconnect();
  galleryView?.newerObserver?.disconnect();
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
    range: {},
    previous: null,
    seek: 0,
    poll: null,
    queue: [],
    workers: 0,
    days: {},
    plans: {},
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
  const tileImage = async (button, item) => {
    try {
      const result = await cachedPhoto(previewRoute(item));
      if (!current() || !button.isConnected || !result.data) return;
      const img = document.createElement("img");
      img.alt = "";
      img.src = result.data;
      button.prepend(img);
    } catch {
      /* A missing preview leaves the placeholder. */
    }
  };
  const periodLabel = (period) =>
    period.length === 4
      ? period
      : new Date(`${period}-01T12:00:00`).toLocaleDateString("en", { month: "short", year: "numeric" });
  async function showPeriods(level) {
    const box = root.querySelector(".photo-periods");
    const seek = state.seek;
    let data;
    try {
      data = await api(`/v1/gallery/periods?${new URLSearchParams({ volume, level: level === "years" ? "year" : "month" })}`);
    } catch {
      if (current() && galleryZoom === level) box.textContent = "Could not load this view.";
      return;
    }
    if (!current() || galleryZoom !== level || state.seek !== seek) return;
    box.innerHTML = `<div class="period-grid period-${level}">${data.periods
      .map(
        (p) =>
          `<button type="button" class="period-tile" data-period="${escape(p.period)}" aria-label="${escape(`${periodLabel(p.period)}, ${countLabel(p.count, "photo")}`)}"><span class="period-name">${escape(periodLabel(p.period))}</span><span class="period-count">${p.count.toLocaleString("en")}</span></button>`,
      )
      .join("")}</div>`;
    box.querySelectorAll(".period-tile").forEach((tile, index) => {
      const p = data.periods[index];
      tileImage(tile, p);
      tile.onclick = () => {
        galleryZoom = "days";
        state.setZoom();
        seekMonth(level === "years" ? p.latest || `${p.period}-12` : p.period);
      };
    });
  }
  state.setZoom = () => {
    const periods = galleryZoom !== "days";
    root.classList.toggle("gallery-periods-view", periods);
    root.querySelector(".photo-periods").hidden = !periods;
    document
      .querySelectorAll('.gallery-zoom button[data-action="gallery-zoom"]')
      .forEach((control) => {
        const on = control.dataset.id === galleryZoom;
        control.classList.toggle("active", on);
        control.setAttribute("aria-pressed", String(on));
      });
    if (periods) showPeriods(galleryZoom);
    else root.querySelector(".photo-periods").replaceChildren();
  };
  const showMemories = async () => {
    const box = root.querySelector(".photo-memories");
    const now = new Date();
    const day = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    try {
      const data = await api(`/v1/gallery/memories?${new URLSearchParams({ volume, day, year: String(now.getFullYear()) })}`);
      if (!current() || !data.memories.length) {
        if (current()) box.hidden = true;
        return;
      }
      box.hidden = Boolean(state.month);
      box.innerHTML = `<div class="section-label">On this day</div><div class="memory-grid">${data.memories
        .slice(0, 4)
        .map((m) => {
          const ago = now.getFullYear() - Number(m.year);
          return `<button type="button" class="memory-card" data-year="${escape(m.year)}"><span class="memory-title">${escape(new Date(`${m.year}-${day}T12:00:00`).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" }))}</span><span class="memory-sub">${ago === 1 ? "1 year ago" : `${ago} years ago`} · ${escape(countLabel(m.count, "photo"))}</span></button>`;
        })
        .join("")}</div>`;
      box.querySelectorAll(".memory-card").forEach((card, index) => {
        tileImage(card, data.memories[index]);
        card.onclick = () => seekMonth(`${data.memories[index].year}-${day.slice(0, 2)}`);
      });
    } catch {
      if (current()) box.hidden = true;
    }
  };
  state.showMemories = showMemories;
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
  syncHubOnlyControls();
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
    for (const block of root.querySelectorAll(".photo-block"))
      if (!block.querySelector(".photo-thumb")) block.remove();
    for (const group of root.querySelectorAll(".photo-day"))
      if (!group.querySelector(".photo-thumb")) group.remove();
    updateSelection();
    layoutPhotos();
    if (!root.querySelector(".photo-thumb") && !state.next)
      root.querySelector(".photo-days").innerHTML = empty(
        "No photos yet",
        "Photos added to this folder appear here.",
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
  const monthPlan = (month) => {
    const days = Object.keys(state.days)
      .filter((key) => key.length === 10 && key.startsWith(month))
      .sort()
      .reverse();
    if (!days.length) return null;
    const blocks = [];
    for (const key of days) {
      const count = state.days[key];
      const last = blocks.at(-1);
      if (count < GALLERY_QUIET_BELOW && last?.kind === "quiet") {
        last.days.push(key);
        last.count += count;
      } else
        blocks.push({
          kind: count >= GALLERY_HERO_AT ? "hero" : count < GALLERY_QUIET_BELOW ? "quiet" : "day",
          days: [key],
          count,
        });
    }
    for (const block of blocks)
      if (block.kind === "quiet" && block.days.length === 1) block.kind = "day";
    return { blocks, of: new Map(blocks.flatMap((block) => block.days.map((key) => [key, block]))) };
  };
  const blockHeading = (block) => {
    const label =
      block.kind === "quiet"
        ? galleryRange(block.days)
        : galleryDayHeading(block.days[0]);
    return `<h3>${escape(label)}<span class="photo-count">${escape(countLabel(block.count, "photo"))}</span></h3>`;
  };
  function gridFor(group, month, dayKey) {
    const plan = (state.plans[month] ||= monthPlan(month) || false);
    const block = plan && dayKey.length === 10 && plan.of.get(dayKey);
    if (!block) return group.querySelector(".photo-grid");
    let element = [...group.querySelectorAll(".photo-block")].find(
      (el) => el.dataset.block === block.days[0],
    );
    if (!element) {
      element = document.createElement("div");
      element.className = `photo-block photo-block-${block.kind}`;
      element.dataset.block = block.days[0];
      element.innerHTML = `${blockHeading(block)}${block.kind === "hero" ? '<div class="photo-mosaic"><div class="photo-hero"></div><div class="photo-side"></div></div>' : ""}<div class="photo-grid"></div>`;
      group.append(element);
    }
    const placed = Number(element.dataset.placed || 0);
    element.dataset.placed = String(placed + 1);
    if (block.kind === "hero" && placed === 0)
      return element.querySelector(".photo-hero");
    if (block.kind === "hero" && placed <= GALLERY_SIDE_TILES)
      return element.querySelector(".photo-side");
    return element.querySelector(".photo-grid");
  }
  function addItems(items) {
    for (const item of items) {
      if (state.paths.has(item.path)) continue;
      state.paths.add(item.path);
      const index = state.items.push(item) - 1;
      const dayKey = (item.date || item.captured)?.slice(0, 10) || "";
      const day = dayKey.slice(0, 7) || "unknown";
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
      tile.title = `${galleryPhotoDate(item)}${item.dateSource === "date added" ? " · Date added to Arca" : item.dateSource === "file date" ? " · File date" : ""}`;
      const filename = escape(item.path.split("/").pop());
      tile.innerHTML = `<button type="button" class="photo-open" aria-label="Open ${filename}">${icon(item.kind === "video" ? "play" : "image")}</button>${item.kind === "video" ? `<span class="photo-video-badge" aria-label="Video">${icon("video")}</span>` : ""}<button type="button" class="photo-select" aria-label="Select ${filename}" aria-pressed="${state.selection.has(item.path)}">${icon("check")}</button>`;
      if (item.kind === "video") {
        tile.onpointerenter = (event) => previewVideo(tile, item, event);
        tile.onpointerleave = stopHover;
      }
      tile.querySelector(".photo-open").onclick = () =>
        state.selection.size ? togglePhoto(item) : openGalleryPhoto(index);
      tile.querySelector(".photo-select").onclick = () => togglePhoto(item);
      gridFor(group, day, dayKey).append(tile);
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
  function seekMonth(month) {
    if (state.refreshing) return;
    clearTimeout(state.poll);
    state.poll = null;
    state.seek += 1;
    state.loading = false;
    state.observer?.disconnect();
    state.items = [];
    state.paths.clear();
    state.queue = [];
    root.querySelector(".photo-days").replaceChildren();
    state.next = "";
    state.month = month;
    state.range = { month };
    state.previous = null;
    root.closest(".page").scrollTop = 0;
    for (const button of root.querySelectorAll(".photo-timeline button"))
      button.toggleAttribute("aria-current", button.dataset.month === month);
    state.load();
  }
  function layoutTimeline() {
    const rail = root.querySelector(".photo-timeline");
    const buttons = [...rail.querySelectorAll("button")];
    if (!buttons.length) return;
    const style = getComputedStyle(rail);
    const height =
      rail.clientHeight -
      (parseFloat(style.paddingTop) || 0) -
      (parseFloat(style.paddingBottom) || 0);
    if (
      state.timelineHeight === height &&
      state.timeline?.length === buttons.length
    )
      return;
    state.timelineHeight = height;
    const segments = timelineSegments(
      buttons.map((button) => Number(button.dataset.count)),
      height,
      tokenPixels("--space-1", 4),
    );
    const dotGap = tokenPixels("--space-2", 8);
    const labelGap = tokenPixels("--space-5", 20);
    const years = [];
    let lastDot = -Infinity;
    buttons.forEach((button, index) => {
      const segment = segments[index];
      Object.assign(segment, {
        month: button.dataset.month,
        label: button.dataset.label,
        count: Number(button.dataset.count),
      });
      button.style.setProperty("--segment-top", `${segment.top}px`);
      button.style.setProperty("--segment-height", `${segment.size}px`);
      const dot = segment.top - lastDot >= dotGap;
      button.classList.toggle("photo-dot-hidden", !dot);
      if (dot) lastDot = segment.top;
      if (button.dataset.year) years.push({ button, top: segment.top });
    });
    const shown = [];
    years.forEach((year, index) => {
      const oldest = index === years.length - 1;
      while (
        oldest &&
        shown.length > 1 &&
        year.top - shown.at(-1).top < labelGap
      )
        shown.pop();
      if (oldest || !shown.length || year.top - shown.at(-1).top >= labelGap)
        shown.push(year);
    });
    for (const year of years)
      year.button.classList.toggle("photo-year-hidden", !shown.includes(year));
    state.timeline = segments;
  }
  function timelineAt(clientY) {
    const rail = root.querySelector(".photo-timeline");
    const y =
      clientY -
      rail.getBoundingClientRect().top -
      (parseFloat(getComputedStyle(rail).paddingTop) || 0);
    const segments = state.timeline || [];
    const segment =
      segments.find((item) => y < item.top + item.size) || segments.at(-1);
    const last = segments.at(-1);
    return (
      segment && {
        segment,
        y: Math.max(0, Math.min(y, last.top + last.size)),
      }
    );
  }
  function markHovered(month) {
    for (const button of root.querySelectorAll(".photo-timeline button"))
      button.classList.toggle(
        "photo-date-hovered",
        button.dataset.month === month,
      );
  }
  function showScrub(position) {
    const hover = root.querySelector(".photo-timeline-hover");
    if (!hover || !position) return;
    hover.hidden = false;
    hover.style.setProperty("--hover-top", `${position.y}px`);
    hover.textContent = position.segment.label;
    markHovered(position.segment.month);
  }
  function hideScrub() {
    const hover = root.querySelector(".photo-timeline-hover");
    if (hover) hover.hidden = true;
    markHovered(null);
  }
  function updateSummary(data) {
    const summary = $(".detail-head .heading p");
    if (!data.timeline || !summary || data.indexing) return;
    const total =
      data.timeline.reduce((sum, row) => sum + row.count, 0) +
      (data.undated?.count || 0);
    const videos =
      data.timeline.reduce((sum, row) => sum + (row.videos || 0), 0) +
      (data.undated?.videos || 0);
    summary.textContent = summary.textContent.replace(
      /^[\d,]+ (?:files?|photos?)(?: · [\d,]+ videos?)?(?= · )/,
      [
        countLabel(total - videos, "photo"),
        videos && countLabel(videos, "video"),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  function updateTimeline(data) {
    if (data.timeline) state.dates = data.timeline;
    if (data.undated) state.undated = data.undated;
    updateSummary(data);
    const rail = root.querySelector(".photo-timeline");
    if (data.timeline && !rail.children.length) {
      let year = "";
      for (const date of data.timeline) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.month = date.month;
        button.dataset.count = String(date.count);
        const label = new Date(date.month + "-01T12:00:00").toLocaleDateString(
          "en",
          { month: "short", year: "numeric" },
        );
        button.dataset.label = label;
        button.setAttribute(
          "aria-label",
          `Go to ${label}, ${date.count} ${date.count === 1 ? "photo" : "photos"}`,
        );
        const first = year !== date.month.slice(0, 4);
        if (first) button.dataset.year = date.month.slice(0, 4);
        button.innerHTML = `<span class="photo-year">${first ? date.month.slice(0, 4) : ""}</span><span class="photo-date-dot"></span>`;
        year = date.month.slice(0, 4);
        // Pointer scrubbing seeks on release; this click path serves the keyboard.
        button.onclick = (event) => {
          if (event.detail === 0) seekMonth(date.month);
        };
        button.onfocus = () => {
          const segment = state.timeline?.find(
            (row) => row.month === date.month,
          );
          if (segment) showScrub({ segment, y: segment.top });
        };
        button.onblur = hideScrub;
        if (state.month === date.month)
          button.setAttribute("aria-current", "date");
        rail.append(button);
      }
      state.timeline = null;
      rail.insertAdjacentHTML(
        "beforeend",
        '<div class="photo-timeline-hover" aria-hidden="true" hidden></div>',
      );
      layoutTimeline();
    }
  }
  state.load = async () => {
    if (!current() || state.loading || state.refreshing || state.next === null)
      return;
    const seek = state.seek;
    const live = () => current() && state.seek === seek;
    state.loading = true;
    let waiting = false,
      failed = false;
    const more = root.querySelector(".photo-more");
    more.innerHTML = busyIcon();
    more.setAttribute("aria-label", "Loading gallery");
    more.setAttribute("aria-busy", "true");
    try {
      const data = await galleryPage(
        "/v1/gallery?" +
          new URLSearchParams({
            volume,
            after: state.next,
            ...state.range,
          }),
      );
      const first = !state.next;
      if (!live()) return;
      if (data.indexing) {
        state.indexing = true;
        updateTimeline(data);
        if (!state.items.length) addItems(data.items);
        more.innerHTML = busyIcon();
        more.setAttribute("aria-label", "Preparing gallery");
        waiting = true;
        state.poll = setTimeout(() => {
          state.poll = null;
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
      Object.assign(state.days, data.days);
      state.plans = {};
      addItems(data.items);
      if (first) state.previous = data.previous ?? null;
      state.next = data.next;
      more.hidden = !data.next;
      more.replaceChildren();
      more.removeAttribute("aria-label");
      if (!state.items.length)
        root.querySelector(".photo-days").innerHTML = empty(
          "No photos yet",
          "Photos added to this folder appear here.",
          "",
          "images",
        );
    } catch {
      failed = true;
      if (live()) {
        more.textContent = "Could not load photos. Retrying…";
        more.removeAttribute("aria-label");
        setTimeout(() => live() && state.load(), 5000);
      }
    } finally {
      if (live() && !waiting) {
        state.loading = false;
        more.removeAttribute("aria-busy");
      }
    }
    if (live() && !failed) {
      loadNewerIfNear();
      loadOlderIfNear();
    }
  };
  function replaceItems(items) {
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
    addItems(items);
    const index = state.items.findIndex((item) => item.path === anchorPath);
    const nextAnchor = root.querySelector(`[data-photo="${index}"]`);
    if (nextAnchor && offset != null)
      page.scrollTop += nextAnchor.getBoundingClientRect().top - offset;
  }
  // IntersectionObserver stays silent while a sentinel remains visible across loads.
  const loadOlderIfNear = () => {
    const sentinel = root.querySelector(".photo-more");
    if (
      state.next &&
      sentinel &&
      !sentinel.hidden &&
      sentinel.getBoundingClientRect().top <
        root.closest(".page").getBoundingClientRect().bottom + 400
    )
      void state.load();
  };
  const loadNewerIfNear = () => {
    const sentinel = root.querySelector(".photo-newer");
    if (
      state.previous &&
      sentinel &&
      sentinel.getBoundingClientRect().bottom >
        root.closest(".page").getBoundingClientRect().top - 400
    )
      void state.loadNewer();
  };
  state.loadNewer = async () => {
    if (!current() || state.loading || state.refreshing || !state.previous)
      return;
    const seek = state.seek;
    const live = () => current() && state.seek === seek;
    state.loading = true;
    try {
      const data = await galleryPage(
        "/v1/gallery?" +
          new URLSearchParams({ volume, before: state.previous }),
      );
      if (!live()) return;
      if (!data.items.length) {
        state.previous = null;
        return;
      }
      Object.assign(state.days, data.days);
      state.plans = {};
      replaceItems([...data.items, ...state.items]);
      state.range = { from: data.items[0].cursor };
      state.previous = data.previous ?? null;
    } catch {
      setTimeout(() => live() && loadNewerIfNear(), 5000);
      return;
    } finally {
      if (live()) state.loading = false;
    }
    loadNewerIfNear();
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
    const range = state.range;
    try {
      const items = [];
      let after = "",
        previous = null,
        data;
      const pages = Math.max(1, Math.ceil(state.items.length / 60));
      for (let page = 0; page < pages; page++) {
        data = await galleryPage(
          "/v1/gallery?" + new URLSearchParams({ volume, ...range, after }),
          true,
        );
        if (!page) previous = data.previous ?? null;
        if (
          !current() ||
          state.loading ||
          state.range !== range ||
          $("#dialog").open ||
          state.selection.size ||
          data.indexing
        )
          return;
        items.push(...data.items);
        Object.assign(state.days, data.days);
        state.plans = {};
        after = data.next;
        if (!after) break;
      }
      state.previous = previous;
      updateSummary(data);
      if (JSON.stringify(items) === JSON.stringify(state.items)) return;
      root.querySelector(".photo-timeline").replaceChildren();
      updateTimeline(data);
      replaceItems(items);
      state.next = after;
      root.querySelector(".photo-more").hidden = !after;
    } catch {
      /* Keep the visible gallery during temporary disconnection. */
    } finally {
      state.refreshing = false;
    }
  };
  const refreshTimer = setInterval(refreshGallery, 5000);
  document.addEventListener("visibilitychange", refreshGallery);
  document.addEventListener("arca-changes", refreshGallery);
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
  state.newerObserver =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting))
              state.loadNewer();
          },
          { rootMargin: "400px" },
        )
      : null;
  state.newerObserver?.observe(root.querySelector(".photo-newer"));
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
    layoutTimeline();
  };
  let scrubbing = false;
  rail.onpointerdown = (event) => {
    if (event.button !== 0 || !state.timeline?.length) return;
    scrubbing = true;
    rail.setPointerCapture?.(event.pointerId);
    showScrub(timelineAt(event.clientY));
    event.preventDefault();
  };
  rail.onpointermove = (event) => showScrub(timelineAt(event.clientY));
  rail.onpointerup = (event) => {
    if (!scrubbing) return;
    scrubbing = false;
    const position = timelineAt(event.clientY);
    hideScrub();
    if (position) seekMonth(position.segment.month);
  };
  rail.onpointercancel = () => {
    scrubbing = false;
    hideScrub();
  };
  let hovering = false;
  rail.onpointerenter = () => {
    hovering = true;
  };
  rail.onpointerleave = () => {
    hovering = false;
    if (!scrubbing) hideScrub();
  };
  const showScrollDate = (month) => {
    const segment = state.timeline?.find((row) => row.month === month);
    if (!segment || hovering || scrubbing) return;
    showScrub({ segment, y: segment.top });
    clearTimeout(state.scrollDate);
    state.scrollDate = setTimeout(() => {
      if (!hovering && !scrubbing) hideScrub();
    }, 1000);
  };
  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(sizeTimeline)
      : null;
  resizeObserver?.observe(page);
  window.addEventListener("resize", sizeTimeline);
  state.cleanup = () => {
    clearInterval(refreshTimer);
    clearTimeout(state.scrollDate);
    clearTimeout(state.poll);
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
    if (!active) return;
    for (const button of root.querySelectorAll(".photo-timeline button")) {
      if (button.dataset.month === active.dataset.day.slice(0, 7))
        button.setAttribute("aria-current", "date");
      else button.removeAttribute("aria-current");
    }
    showScrollDate(active.dataset.day.slice(0, 7));
  };
  page.addEventListener("scroll", state.onScroll, { passive: true });
  sizeTimeline();
  if (galleryReturn?.volume === volume) {
    const saved = galleryReturn;
    Object.assign(state, {
      next: saved.next,
      previous: saved.previous,
      range: saved.range,
      month: saved.month,
      days: saved.days || {},
    });
    updateTimeline({ timeline: saved.dates, undated: saved.undated });
    addItems(saved.items.filter((item) => !item.deleted));
    root.querySelector(".photo-more").hidden = !state.next;
    page.scrollTop = saved.scroll;
  } else state.load();
  state.setZoom();
  state.showMemories();
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
  if (hubOffline()) return void hubOnlyBlocked();
  const state = galleryView;
  const inViewer = $("#dialog").classList.contains("photo-viewer");
  const remaining = items.map((item) => ({
    ...item,
    deletionId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  }));
  let completed = 0;
  modal(
    modalHeader(
      `Delete ${items.length === 1 ? "this photo" : `${items.length} photos`}?`,
      "Deletes from the shared gallery for everyone, including Live Photo resources. Originals stay in Photos. Recovery depends on this folder’s version retention.",
      "trash-2",
    ),
    async () => {
      try {
        while (remaining.length) {
          const item = remaining[0];
          const deleted = await api("/v1/gallery/delete", {
            id: item.deletionId,
            volume: state.volume,
            path: item.path,
            rev: item.rev,
          });
          for (const path of deleted.paths) {
            const photo = state.items.find((p) => p.path === path);
            const removed = deleted.rows.find((row) => row.path === path);
            if (photo && removed && photo.rev <= removed.rev)
              state.removePhoto(photo);
          }
          completed++;
          remaining.shift();
          for (let index = remaining.length - 1; index >= 0; index--)
            if (deleted.paths.includes(remaining[index].path)) {
              remaining.splice(index, 1);
              completed++;
            }
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
  $("#submit-dialog").classList.add("danger");
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
    ${row(meta.captured ? "Taken" : item.dateSource === "date added" ? "Date added" : item.dateSource === "file date" ? "File date" : "Date", date, "calendar", meta.offset ? `UTC${meta.offset}` : "")}
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
  flip(
    $(".photo-viewer-image"),
    [...document.querySelectorAll(".photo-thumb[data-photo]")]
      .find((tile) => Number(tile.dataset.photo) === index)
      ?.getBoundingClientRect(),
    { uniform: true },
  );
  $("#submit-dialog").hidden = true;
  $("#cancel-dialog").innerHTML = icon("arrow-left");
  $("#cancel-dialog").setAttribute("aria-label", "Back to gallery");
  $(".photo-download").onclick = () => action(() => downloadGalleryPhoto(item));
  $(".photo-delete")?.addEventListener("click", () =>
    deleteGalleryPhotos([item]),
  );
  syncHubOnlyControls();
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
      invoke("open_file", {
        volume: state.volume,
        path: item.path,
        reveal: true,
      }),
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

function folderSymbol(volume) {
  return volume.gallery ? "images" : volume.music ? "music" : "folder";
}
function folderActionsMenu(volume) {
  if (status.role !== "hub") return "";
  const ordinary = !volume.gallery && !volume.music;
  const items =
    (ordinary
      ? button("Enable gallery", "enable-gallery", volume.id, "secondary", "images") +
        button("Enable music library", "enable-music", volume.id, "secondary", "music")
      : "") +
    button("Rename", "rename-share", volume.id, "secondary", "pencil") +
    button(".arcaignore…", "edit-ignore", volume.id, "secondary", "file-pen-line");
  return `<details class="details-menu folder-actions-menu"><summary class="icon-button" aria-label="Folder actions">${icon("ellipsis")}</summary><div class="menu-items">${items}</div></details>`;
}
let galleryZoom = "days";
const galleryZooms = [
  ["years", "Years"],
  ["months", "Months"],
  ["days", "Days"],
];
function galleryZoomControl() {
  return segmented(
    "Gallery zoom",
    galleryZooms.map(([id, label]) => ({
      action: "gallery-zoom",
      id,
      label,
      active: galleryZoom === id,
    })),
    "gallery-zoom",
  );
}
function galleryModeButton(volume, withZoom = true) {
  if (!volume.gallery) return "";
  return (withZoom && folderTab === "gallery" ? galleryZoomControl() : "") + button(
    folderTab === "gallery" ? "View folder" : "Gallery",
    "gallery-mode",
    volume.id,
    "primary gallery-mode-toggle",
    folderTab === "gallery" ? "folder" : "images",
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
    return `<div id="photo-selection" class="photo-selection-bar" hidden><button type="button" class="icon-button photo-selection-clear" aria-label="Clear selection">${icon("x")}</button><strong class="photo-selection-count" role="status"></strong><button type="button" class="secondary danger photo-selection-delete">${icon("trash-2")}Delete selected…</button>${galleryModeButton(v, false)}</div><div id="photo-gallery"><div class="photo-newer" aria-hidden="true"></div><div class="photo-memories" hidden></div><div class="photo-periods" hidden></div><div class="photo-days"></div><nav class="photo-timeline" aria-label="Photo dates"></nav><div class="photo-more" role="status" aria-label="Loading gallery" aria-busy="true">${busyIcon()}</div></div>`;
  if (folderTab === "recent" && !recent) return tools + scaffoldRow("history");
  if (folderTab === "recent")
    return (
      tools +
      (recent.length
        ? `<div class="history-group">${recent.map((r) => revisionRow(r, true)).join("")}</div>`
        : recentSaved.get(v.id)
          ? empty(
              "No saved versions",
              "Offline. Connect to the hub to load its history.",
            )
          : empty("No versions yet", "History appears after the first sync."))
    );
  const parts = folderPrefix.split("/").filter(Boolean);
  const trail = `<nav class="folder-breadcrumb" aria-label="File location">${icon("folder")}${parts.length ? button(escape(v.name), "browse-directory", "", "text-button") : `<span aria-current="location">${escape(v.name)}</span>`}${parts.map((part, i) => `${icon("chevron-right")}${i === parts.length - 1 ? `<span aria-current="location">${escape(part)}</span>` : button(escape(part), "browse-directory", parts.slice(0, i + 1).join("/"), "text-button")}`).join("")}</nav>`;
  const search = folderSearchOpen
    ? `<div class="folder-browser-search"><input id="folder-search-input" type="search" aria-label="Search files" placeholder="Search files" value="${escape(folderSearch)}" maxlength="256">${button("Search", "folder-search-apply", "", "secondary")}</div>`
    : "";
  try {
    const pages = [];
    let after = "";
    for (let loaded = 0; loaded < folderPageCount; loaded++) {
      const page = await readFolderPage(
        "/v1/browse?" +
          new URLSearchParams({
            volume: v.id,
            prefix: folderPrefix,
            search: folderSearch,
            after,
            limit: "100",
          }),
        pending,
      );
      if (!page) return tools + scaffoldRow("history");
      pages.push(page);
      if (!page.next) break;
      after = page.next;
    }
    const data = {
      entries: [
        ...new Map(
          pages.flatMap((page) => page.entries).map((row) => [row.path, row]),
        ).values(),
      ],
      next: pages[pages.length - 1].next,
    };
    const capped = Boolean(data.next) && pages.length >= MAX_FOLDER_PAGES;
    return (
      tools +
      search +
      `<div class="history-group folder-explorer">${trail}` +
      (data.entries.length
        ? `${data.entries.map((row) => `<div class="browser-file-row" role="button" tabindex="0" data-action="${row.directory ? "browse-directory" : "activity-file"}" data-id="${escape(row.directory ? row.path : JSON.stringify({ volume: v.id, path: row.path, rev: row.rev }))}"${row.directory ? "" : ` data-hash="${escape(row.hash || "")}" data-size="${Number(row.size) || 0}" data-name="${escape(row.name)}"`} aria-label="${escape(`Open ${row.name}`)}">${rowPreview({ ...row, volume: v.id }, fileIcon(row.path, row.directory))}<div><strong>${escape(row.name)}</strong><p>${row.directory ? `${row.files} ${row.files === 1 ? "file" : "files"} · ` : ""}${bytes(row.size)}</p></div>${icon("chevron-right")}</div>`).join("")}`
        : empty(
            folderSearch ? "No matching files" : "This folder is empty",
            "",
            "",
            "folder",
          )) +
      "</div>" +
      (data.next
        ? capped
          ? `<p class="hint">Showing the first ${(MAX_FOLDER_PAGES * 100).toLocaleString("en")} files. Search to narrow the list.</p>`
          : `<div class="pagination">${button("Show more files", "browse-more", String(pages.length), "secondary")}</div>`
        : "")
    );
  } catch (error) {
    return (
      tools +
      search +
      `<div class="history-group folder-explorer">${trail}` +
      empty(
        "Files unavailable",
        "Arca could not list this folder’s files. If it keeps happening, update Arca, then try again.",
        button("Retry", "browse-retry", "", "secondary"),
      ) +
      "</div>"
    );
  }
}

const MUSIC_GRID_PAGE = 60;
const MUSIC_LIST_PAGE = 120;
const MUSIC_TABS = { artists: "Artists", albums: "Albums", playlists: "Playlists", recent: "Recent" };
const musicLibraries = new Map();
const musicFailures = new Map();
const musicLoading = new Map();
const musicIndexTimers = new Map();
const musicCovers = new Map();
const observedMusicCovers = new Set();
const musicCoverQueue = [];
let musicCoverObserver,
  musicCoverWorkers = 0,
  musicShown = {},
  musicPlayer = null,
  musicElement = null,
  musicSerial = 0,
  musicSessionReady = false,
  musicView = { tab: "artists", artist: null, album: null, playlist: null, pages: 1, trail: [] },
  musicQuery = musicSearch(),
  musicPicking = null;
function musicSearch(open = false) {
  return { open, text: "", songs: 1, albums: 1, artists: 1 };
}
const musicSearching = () => searchText(musicQuery.text).trim() !== "";
const musicCount = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
const musicClock = (seconds) => formatDuration(Math.floor(seconds || 0)) || "0:00";
function musicAvailable(volume) {
  return !!volume?.music && !volume.gallery && (status.role === "hub" || !!volume.selected);
}
function musicModeButton(volume) {
  if (!musicAvailable(volume)) return "";
  return button(
    folderTab === "library" ? "View folder" : "Library",
    "music-mode",
    volume.id,
    "primary",
    folderTab === "library" ? "folder" : "music",
  );
}
const musicKey = (volume) => `${status.id}:${volume}`;
const musicHistoryKey = (volume) => `arca-music-recent:${status.hubId || status.id}:${volume}`;
function musicHistory(volume) {
  try {
    const list = JSON.parse(localStorage.getItem(musicHistoryKey(volume)) || "[]");
    return Array.isArray(list)
      ? list.filter((entry) => ["album", "playlist"].includes(entry?.kind) && typeof entry.id === "string")
      : [];
  } catch {
    return [];
  }
}
function rememberMusic(volume, context) {
  try {
    localStorage.setItem(
      musicHistoryKey(volume),
      JSON.stringify(rememberPlayed(musicHistory(volume), { kind: context.kind, id: context.id })),
    );
  } catch {}
}
function renameMusicHistory(volume, from, to) {
  try {
    localStorage.setItem(
      musicHistoryKey(volume),
      JSON.stringify(
        musicHistory(volume).map((entry) =>
          entry.kind === "playlist" && entry.id === from ? { ...entry, id: to } : entry,
        ),
      ),
    );
  } catch {}
}
async function loadMusicLibrary(volume) {
  const key = musicKey(volume);
  const known = musicLibraries.get(key);
  const query = new URLSearchParams({ volume });
  if (known) query.set("version", known.version);
  const data = await api("/v1/music/library?" + query);
  if (data.unchanged && known) {
    known.indexing = !!data.indexing;
    known.checked = Date.now();
    return known;
  }
  const entry = {
    version: data.version,
    indexing: !!data.indexing,
    checked: Date.now(),
    library: buildLibrary(data),
  };
  musicLibraries.delete(key);
  musicLibraries.set(key, entry);
  while (musicLibraries.size > 8) musicLibraries.delete(musicLibraries.keys().next().value);
  musicRequeue(volume, entry.library);
  return entry;
}
const musicShowing = (volume) =>
  view === "folders" && detailId === volume && folderTab === "library";
function armMusicIndex(volume) {
  clearTimeout(musicIndexTimers.get(volume));
  musicIndexTimers.set(
    volume,
    setTimeout(() => {
      musicIndexTimers.delete(volume);
      if (musicShowing(volume)) void refreshMusic(volume, true);
    }, 5000),
  );
}
function refreshMusic(volume, force = false) {
  const key = musicKey(volume);
  const known = musicLibraries.get(key);
  if (musicLoading.has(key)) return musicLoading.get(key);
  if (!force && known && Date.now() - known.checked < 10000) return Promise.resolve();
  const job = readMusic(volume, key, known);
  musicLoading.set(key, job);
  return job;
}
async function readMusic(volume, key, known) {
  const indexing = known?.indexing;
  try {
    const entry = await loadMusicLibrary(volume);
    musicFailures.delete(key);
    if (entry.indexing) armMusicIndex(volume);
    if ((entry !== known || entry.indexing !== indexing) && musicShowing(volume))
      renderMusic(status.volumes.find((v) => v.id === volume));
  } catch (error) {
    if (known) return void (known.indexing && armMusicIndex(volume));
    musicFailures.set(key, error.message);
    if (musicShowing(volume)) renderMusic(status.volumes.find((v) => v.id === volume));
  } finally {
    musicLoading.delete(key);
  }
}
function musicCover(volume, key, symbol = "disc-3", cls = "") {
  const query = key ? new URLSearchParams({ volume, key }).toString() : "";
  return `<span class="music-cover${cls}"${query ? ` data-music-cover="${escape(query)}"` : ""}>${symbol ? icon(symbol) : ""}</span>`;
}
function musicCard(volume, action, id, cover, title, subtitle, symbol = "disc-3") {
  return `<button type="button" class="music-card" data-action="${action}" data-id="${escape(id)}">${musicCover(volume, cover, symbol)}<strong>${escape(title)}</strong><span>${escape(subtitle)}</span></button>`;
}
const albumCard = (volume, album, subtitle = album.artist) =>
  musicCard(volume, "music-album", album.id, album.cover, album.title, subtitle);
const playlistCard = (volume, list) =>
  musicCard(volume, "music-playlist", list.id, list.cover, list.name, musicCount(list.entries.length, "track"), "list-music");
const musicEditable = (v) => !!v.selected;
const musicMenu = (items, label = "Track actions") =>
  `<details class="details-menu file-actions-menu music-track-menu"><summary class="ghost icon-button" aria-label="${label}">${icon("ellipsis")}</summary><div class="menu-items">${items}</div></details>`;
const musicHeadRow = (album = false) =>
  `<div class="music-track music-track-head" aria-hidden="true"><div class="music-track-play"><span>#</span><span>Title</span><span>Artist</span>${album ? "<span>Album</span>" : ""}${icon("clock")}</div><span></span></div>`;
function musicGrid(cards, size = Infinity, more = "") {
  const shown = cards.slice(0, size);
  return `<div class="music-grid">${shown.join("")}</div>${cards.length > shown.length ? `<div class="pagination">${button("Show more", more ? "music-search-more" : "music-more", more, "secondary")}</div>` : ""}`;
}
const musicMore = (label, more) => `<div class="pagination">${button(label, "music-search-more", more, "secondary")}</div>`;
const musicShuffleAll = () =>
  musicView.album || musicView.playlist || musicView.artist || musicSearching()
    ? ""
    : button("Shuffle", "music-shuffle-all", "", "secondary", "shuffle");
function musicTabs(library) {
  return `<div class="folder-browser-tools"><div class="music-tools">${segmented(
    "Library",
    [
      { id: "artists", symbol: "mic-vocal" },
      { id: "albums", symbol: "disc-3" },
      ...(library.playlists.length ? [{ id: "playlists", symbol: "list-music" }] : []),
      { id: "recent", symbol: "clock" },
    ].map((item) => ({
      ...item,
      label: MUSIC_TABS[item.id],
      action: "music-tab",
      active: musicView.tab === item.id,
    })),
  )}${musicShuffleAll()}</div><div><button class="icon-button" data-action="music-search-toggle" aria-label="${musicQuery.open ? "Close search" : "Search music"}">${icon(musicQuery.open ? "x" : "search")}</button></div></div>${
    musicQuery.open
      ? `<div class="folder-browser-search"><input id="music-search-input" type="search" aria-label="Search music" placeholder="Search music" value="${escape(musicQuery.text)}" maxlength="256">${button("Search", "music-search-apply", "", "secondary")}</div>`
      : ""
  }`;
}
const musicBackLabel = () => (musicSearching() ? "Results" : MUSIC_TABS[musicView.tab]);
function musicRows(v, rows, action, { head = "", songs = false, playlist = "", album = false } = {}) {
  const editable = musicEditable(v);
  return `<div class="history-group music-tracks${songs ? " music-songs" : ""}${album ? " music-with-album" : ""}" data-volume="${escape(v.id)}"${playlist ? ` data-playlist="${escape(playlist)}"` : ""}>${head}${rows
    .map((row, index) => {
      const number = `<span class="music-track-number mono">${index + 1}</span><span class="music-track-playing">${icon("music")}</span>`;
      const position = row.position === undefined ? "" : ` data-position="${row.position}"`;
      const remove = row.remove ? button("Remove from playlist", "music-remove", String(row.position), "secondary", "list-minus") : "";
      if (!row.track)
        return `<div class="music-track music-track-missing"${position}><div class="music-track-play">${number}<strong>${escape(row.title)}</strong><span>${escape(row.note)}</span>${album ? "<span></span>" : ""}<span class="mono"></span></div>${remove ? musicMenu(remove) : "<span></span>"}</div>`;
      const items = (editable ? button("Add to playlist…", "music-add", row.track.path, "secondary", "list-plus") : "") + remove;
      return `<div class="music-track" data-path="${escape(row.track.path)}"${position}><button type="button" class="music-track-play" data-action="${action}" data-id="${escape(row.id)}" aria-label="${escape(`Play ${row.track.title}`)}">${number}<strong>${escape(row.track.title)}</strong><span>${escape(row.subtitle)}</span>${album ? `<span>${escape(row.track.album)}</span>` : ""}<span class="mono">${formatDuration(row.track.duration)}</span></button>${items ? musicMenu(items) : "<span></span>"}</div>`;
    })
    .join("")}</div>`;
}
function musicRow(v, action, id, cover, title, subtitle, symbol) {
  return `<button type="button" class="music-row" data-action="${action}" data-id="${escape(id)}">${musicCover(v.id, cover, symbol)}<span><strong>${escape(title)}</strong><span>${escape(subtitle)}</span></span>${icon("chevron-right")}</button>`;
}
function musicResults(v, library) {
  const text = musicQuery.text.trim();
  const query = searchText(text).trim();
  const has = (...values) => values.some((value) => searchText(value).includes(query));
  const songs = library.albumList
    .flatMap((album) => album.tracks)
    .filter((track) => has(track.title, track.artist, track.albumArtist, track.album));
  const albums = library.albumList.filter((album) => has(album.title, album.artist));
  const artists = library.artists.filter((artist) => has(artist.name));
  const playlists = library.playlists.filter((list) => has(list.name));
  if (!songs.length && !albums.length && !artists.length && !playlists.length)
    return empty(`No results for “${escape(text)}”`, "", "", "search");
  const shown = songs.slice(0, musicQuery.songs * MUSIC_LIST_PAGE);
  const listed = artists.slice(0, musicQuery.artists * MUSIC_LIST_PAGE);
  return [
    songs.length &&
      section(
        "Songs",
        musicRows(
          v,
          shown.map((track) => ({ track, id: track.path, subtitle: `${track.artist} · ${track.album}` })),
          "music-song",
          { songs: true },
        ) + (songs.length > shown.length ? musicMore("Show more songs", "songs") : ""),
      ),
    albums.length &&
      section("Albums", musicGrid(albums.map((album) => albumCard(v.id, album)), musicQuery.albums * MUSIC_GRID_PAGE, "albums")),
    artists.length &&
      section(
        "Artists",
        `<div class="history-group">${listed.map((artist) => musicRow(v, "music-artist", artist.id, artist.cover, artist.name, musicCount(artist.albums.length, "album"), "mic-vocal")).join("")}</div>` +
          (artists.length > listed.length ? musicMore("Show more artists", "artists") : ""),
      ),
    playlists.length &&
      section(
        "Playlists",
        `<div class="history-group">${playlists.map((list) => musicRow(v, "music-playlist", list.id, list.cover, list.name, musicCount(list.entries.length, "track"), "list-music")).join("")}</div>`,
      ),
  ]
    .filter(Boolean)
    .join("");
}
function musicArtists(v, library) {
  const shown = library.artists.slice(0, musicView.pages * MUSIC_LIST_PAGE);
  return `${artistGroups(shown)
    .map((group) =>
      section(
        group.letter,
        `<div class="history-group">${group.artists
          .map((artist) => {
            const tracks = artist.albums.reduce((total, album) => total + album.tracks.length, 0);
            return `<button type="button" class="music-row music-artist-row" data-action="music-artist" data-id="${escape(artist.id)}">${musicCover(v.id, artist.cover, "mic-vocal")}<span><strong>${escape(artist.name)}</strong><span>${musicCount(artist.albums.length, "album")} · ${musicCount(tracks, "track")}</span></span><span class="music-artist-albums" aria-hidden="true">${artist.covers
              .slice(1, 6)
              .map((key) => musicCover(v.id, key, null))
              .join("")}</span>${icon("chevron-right")}</button>`;
          })
          .join("")}</div>`,
      ),
    )
    .join("")}${library.artists.length > shown.length ? `<div class="pagination">${button("Show more", "music-more", "", "secondary")}</div>` : ""}`;
}
function musicArtist(v, artist) {
  const tracks = artist.albums.reduce((total, album) => total + album.tracks.length, 0);
  return `<div class="music-head">${musicCover(v.id, artist.cover, "mic-vocal", " large")}<div class="music-head-info">${button(escape(musicSearching() ? "Results" : "Artists"), "music-back", "", "back", "chevron-left")}<div><h2>${escape(artist.name)}</h2><p>${musicCount(artist.albums.length, "album")} · ${musicCount(tracks, "track")}</p><div class="heading-actions">${button("Shuffle", "music-shuffle-artist", "", "secondary", "shuffle")}</div></div></div></div>${musicGrid(
    artist.albums.map((item) => albumCard(v.id, item, item.year ? String(item.year) : musicCount(item.tracks.length, "track"))),
    musicView.pages * MUSIC_GRID_PAGE,
  )}`;
}
function musicTracks(v, album) {
  const back = musicView.artist ? album.artist : musicBackLabel();
  const summary = [
    album.artist,
    album.year,
    musicCount(album.tracks.length, "track"),
    formatDuration(album.duration),
  ].filter(Boolean);
  const shown = album.tracks.slice(0, musicView.pages * MUSIC_LIST_PAGE);
  return `<div class="music-head">${musicCover(v.id, album.cover, "disc-3", " large")}<div class="music-head-info">${button(escape(back), "music-back", "", "back", "chevron-left")}<div><h2>${escape(album.title)}</h2><p>${escape(summary.join(" · "))}</p><div class="heading-actions">${button("Play", "music-play", "", "primary", "play")}${button("Shuffle", "music-shuffle", "", "secondary", "shuffle")}</div></div></div></div>${musicRows(
    v,
    shown.map((track, index) => ({ track, id: index, subtitle: track.artist })),
    "music-track",
    { head: musicHeadRow() },
  )}${album.tracks.length > shown.length ? `<div class="pagination">${button("Show more tracks", "music-more", "", "secondary")}</div>` : ""}`;
}
function musicPlaylist(v, list) {
  const pending = status.role !== "hub" && v.sync?.state !== "synced";
  const editable = list.editable && musicEditable(v);
  const menu = editable
    ? musicMenu(
        button("Rename…", "music-playlist-rename", list.id, "secondary", "pencil") +
          button("Delete playlist…", "music-playlist-delete", list.id, "secondary danger menu-item-separated", "trash-2"),
        "Playlist actions",
      )
    : "";
  const shown = list.entries.slice(0, musicView.pages * MUSIC_LIST_PAGE);
  const summary = [musicCount(list.entries.length, "track"), formatDuration(list.duration)].filter(Boolean);
  const rows = shown.map((entry) =>
    entry.track
      ? { track: entry.track, id: list.positions.indexOf(entry.position), subtitle: entry.track.artist, position: entry.position, remove: editable }
      : {
          title: entry.path ? entry.path.slice(entry.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") : "Unknown entry",
          note: entry.path && pending ? "Not on this device yet" : "Not in this folder",
          position: entry.position,
          remove: editable,
        },
  );
  return `<div class="music-head">${musicCover(v.id, list.cover, "list-music", " large")}<div class="music-head-info">${button(escape(musicBackLabel()), "music-back", "", "back", "chevron-left")}<div><h2>${escape(list.name)}</h2><p>${escape(summary.join(" · "))}</p><div class="heading-actions">${list.tracks.length ? button("Play", "music-play", "", "primary", "play") + button("Shuffle", "music-shuffle", "", "secondary", "shuffle") : ""}${menu}</div></div></div></div>${musicRows(v, rows, "music-track", { head: musicHeadRow(true), playlist: list.id, album: true })}${list.entries.length > shown.length ? `<div class="pagination">${button("Show more tracks", "music-more", "", "secondary")}</div>` : ""}`;
}
function musicRecent(v, library) {
  const played = playedItems(library, musicHistory(v.id));
  if (played.length)
    return musicGrid(played.map(({ kind, item }) => (kind === "album" ? albumCard(v.id, item) : playlistCard(v.id, item))));
  if (library.recent.length)
    return `<p class="music-caption">Recently added · Albums and playlists you play on this device appear here.</p>${musicGrid(library.recent.map((album) => albumCard(v.id, album)))}`;
  return empty("Nothing played yet", "Albums and playlists you play on this device appear here.", "", "clock");
}
function musicBody(v, entry) {
  const library = entry.library;
  if (!library.tracks.size)
    return entry.indexing
      ? empty("Reading this library", "Albums appear as Arca reads the tags.", "", "music")
      : empty("No music yet", "Audio files added to this folder appear here.", "", "music");
  if (musicView.tab === "playlists" && !library.playlists.length)
    musicView = { tab: "artists", artist: null, album: null, playlist: null, pages: 1, trail: [] };
  const content = musicContent(v, library);
  return `${musicTabs(library)}<div class="music-view">${content}</div>`;
}
function musicContent(v, library) {
  const album = musicView.album && library.albums.get(musicView.album);
  if (album) return musicTracks(v, album);
  const list = musicView.playlist && library.playlists.find((item) => item.id === musicView.playlist);
  if (list) return musicPlaylist(v, list);
  musicView.album = musicView.playlist = null;
  const artist = musicView.artist && library.artists.find((item) => item.id === musicView.artist);
  if (artist) return musicArtist(v, artist);
  musicView.artist = null;
  if (musicSearching()) return musicResults(v, library);
  const size = musicView.pages * MUSIC_GRID_PAGE;
  if (musicView.tab === "artists") return musicArtists(v, library);
  if (musicView.tab === "recent") return musicRecent(v, library);
  if (musicView.tab === "playlists") return musicGrid(library.playlists.map((item) => playlistCard(v.id, item)), size);
  return musicGrid(library.albumList.map((item) => albumCard(v.id, item)), size);
}
function musicSearchInput(value) {
  const v = status.volumes.find((item) => item.id === detailId);
  const entry = v && musicLibraries.get(musicKey(v.id));
  const region = $("#content .music-view");
  if (!entry || !region) return;
  musicQuery = { ...musicSearch(true), text: value };
  if (musicView.album || musicView.playlist || musicView.artist)
    musicView = { ...musicView, album: null, playlist: null, artist: null, pages: 1, trail: [] };
  region.innerHTML = musicContent(v, entry.library);
  const tools = $("#content .music-tools");
  tools?.querySelector('[data-action="music-shuffle-all"]')?.remove();
  tools?.insertAdjacentHTML("beforeend", musicShuffleAll());
  musicShown.place = musicPlace(v);
  musicShown.state = musicState(v, entry, musicFailures.get(musicKey(v.id)));
  icons();
  mountMusicCovers();
  markMusicPlaying();
}
const musicPlace = (v) => JSON.stringify([v.id, musicView.tab, musicView.artist, musicView.album, musicView.playlist]);
const musicState = (v, entry, failure) =>
  JSON.stringify([musicPlace(v), musicView.pages, entry?.version, entry?.indexing, failure, musicQuery]);
function musicHeading(v, entry) {
  const library = entry?.library;
  const summary = library
    ? `${musicCount(library.tracks.size, "track")} · ${musicCount(library.albumList.length, "album")} · ${bytes(v.bytes || 0)}`
    : `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)}`;
  return `<div class="heading"><div class="detail-title"><div class="tile large">${icon("music")}</div><div><h1>${escape(v.name)}</h1><p>${summary}</p></div></div><div class="heading-actions">${musicModeButton(v)}${folderActionsMenu(v)}</div></div>`;
}
function renderMusic(v, scroll = null) {
  if (!v) return;
  const key = musicKey(v.id);
  const entry = musicLibraries.get(key);
  const failure = musicFailures.get(key);
  const content = $("#content");
  const page = content.querySelector(".music-page");
  const typing = document.activeElement?.id === "music-search-input";
  const place = () => musicPlace(v);
  const state = () => musicState(v, entry, failure);
  const head = button("Folders", "back-folders", "", "back", "chevron-left") + musicHeading(v, entry);
  if (scroll === null && page && content.dataset.detail === v.id && musicShown.state === state()) {
    if (musicShown.head !== head) {
      content.querySelector(".detail-head").innerHTML = head;
      musicShown.head = head;
      icons();
    }
    return;
  }
  const keep = scroll ?? (musicShown.place === place() && page ? page.scrollTop : 0);
  const body = entry
    ? musicBody(v, entry)
    : failure
      ? empty("Library unavailable", "Arca could not read this music library. Try again.", button("Retry", "music-retry", "", "secondary"), "music")
      : scaffoldRow("card");
  content.innerHTML = `<div class="detail-head">${head}</div><div class="page music-page">${body}</div>`;
  content.dataset.detail = v.id;
  musicShown = { place: place(), state: state(), head };
  icons();
  mountMusicCovers();
  markMusicPlaying();
  if (keep) $("#content .music-page").scrollTop = keep;
  const field = typing && $("#music-search-input");
  if (field) {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
}
function paintMusicCover(el, data) {
  if (!data || !el.isConnected || el.querySelector("img")) return;
  const img = new Image();
  img.alt = "";
  img.onload = () => el.classList.add("has-cover");
  img.src = data;
  el.append(img);
}
function rememberCover(query, data) {
  musicCovers.delete(query);
  musicCovers.set(query, data);
  while (musicCovers.size > 400) musicCovers.delete(musicCovers.keys().next().value);
}
function mountMusicCovers() {
  for (const el of observedMusicCovers)
    if (!el.isConnected) {
      musicCoverObserver?.unobserve(el);
      observedMusicCovers.delete(el);
    }
  const drain = () => {
    while (musicCoverWorkers < 4 && musicCoverQueue.length) {
      const el = musicCoverQueue.shift();
      const query = el.dataset.musicCover;
      if (!el.isConnected) continue;
      if (musicCovers.has(query)) {
        paintMusicCover(el, musicCovers.get(query));
        continue;
      }
      musicCoverWorkers++;
      api(`/v1/music/cover?${query}&size=small`)
        .then((value) => {
          if (value.retry) return;
          rememberCover(query, value.data || null);
          paintMusicCover(el, value.data);
          const track = musicCurrent();
          if (value.data && track?.cover && query === new URLSearchParams({ volume: musicPlayer.volume, key: track.cover }).toString())
            musicSession();
        })
        .catch(() => {})
        .finally(() => {
          musicCoverWorkers--;
          drain();
        });
    }
  };
  if (!musicCoverObserver && typeof IntersectionObserver !== "undefined")
    musicCoverObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            musicCoverObserver.unobserve(entry.target);
            observedMusicCovers.delete(entry.target);
            musicCoverQueue.push(entry.target);
          }
        drain();
      },
      { rootMargin: "200px" },
    );
  for (const el of document.querySelectorAll("[data-music-cover]:not([data-observed])")) {
    el.dataset.observed = "true";
    if (musicCovers.has(el.dataset.musicCover)) paintMusicCover(el, musicCovers.get(el.dataset.musicCover));
    else if (musicCoverObserver) {
      observedMusicCovers.add(el);
      musicCoverObserver.observe(el);
    }
  }
}
const musicCurrent = () => musicPlayer && musicPlayer.tracks[musicPlayer.order[musicPlayer.position]];
function musicAudio() {
  if (musicElement) return musicElement;
  musicElement = document.createElement("audio");
  musicElement.preload = "auto";
  musicElement.hidden = true;
  try {
    const level = localStorage.getItem("arca-music-volume");
    if (level !== null && Number(level) >= 0 && Number(level) <= 1) musicElement.volume = Number(level);
  } catch {}
  musicElement.addEventListener("timeupdate", musicProgress);
  musicElement.addEventListener("durationchange", musicProgress);
  musicElement.addEventListener("play", musicControls);
  musicElement.addEventListener("pause", musicControls);
  musicElement.addEventListener("ended", musicEnded);
  musicElement.addEventListener("error", musicFailed);
  document.body.append(musicElement);
  return musicElement;
}
function musicResume() {
  const audio = musicAudio();
  if (!musicPlayer || musicPlayer.loading) return;
  if (musicPlayer.failed || !audio.getAttribute("src"))
    return void musicLoad(musicPlayer.failed ? musicPlayer.at || 0 : 0);
  try {
    audio.play()?.catch?.(() => musicControls());
  } catch {
    musicControls();
  }
}
function musicStart(volume, context, tracks, start, shuffle, positions = null) {
  musicPlayer = {
    volume,
    context,
    tracks,
    positions,
    shuffle,
    repeat: musicPlayer?.repeat || "off",
    order: shuffle ? shuffleOrder(tracks.length, start) : tracks.map((_, index) => index),
    position: shuffle ? 0 : start,
    failed: false,
    scope: musicScope(),
  };
  if (["album", "playlist"].includes(context.kind)) rememberMusic(volume, context);
  return musicLoad();
}
function musicSeekOnLoad(at) {
  if (!at) return;
  const serial = musicSerial;
  const src = musicElement.getAttribute("src");
  musicElement.addEventListener(
    "loadedmetadata",
    () => {
      if (serial === musicSerial && musicElement.getAttribute("src") === src) musicElement.currentTime = at;
    },
    { once: true },
  );
}
function musicLoad(at = 0) {
  const state = musicPlayer;
  const track = musicCurrent();
  const serial = ++musicSerial;
  const audio = musicAudio();
  state.failed = false;
  state.renewed = false;
  state.at = at;
  state.loading = native;
  const query = new URLSearchParams({ volume: state.volume, path: track.path, hash: track.hash });
  const begin = (url) => {
    state.loading = false;
    audio.src = url;
    musicSeekOnLoad(at);
    musicResume();
  };
  renderPlayer();
  markMusicPlaying();
  musicSession();
  if (!native) return begin("/v1/music/media?" + query);
  audio.pause?.();
  return api("/v1/music/playback?" + query).then(
    ({ url }) => serial === musicSerial && begin(url),
    (error) => {
      if (serial !== musicSerial) return;
      state.loading = false;
      state.failed = true;
      musicControls();
      notice(error.message, true, { id: "music" });
    },
  );
}
function musicFailed() {
  const state = musicPlayer;
  const track = musicCurrent();
  if (!state || state.loading || !track || !musicElement.getAttribute("src")) return;
  const serial = musicSerial;
  const code = musicElement.error?.code;
  const playing = !musicElement.paused;
  state.failed = true;
  if (musicElement.readyState >= musicElement.HAVE_METADATA) state.at = musicElement.currentTime || 0;
  musicControls();
  api("/v1/music/playback?" + new URLSearchParams({ volume: state.volume, path: track.path, hash: track.hash })).then(
    ({ url }) => {
      if (serial !== musicSerial) return;
      if (native && !state.renewed) {
        state.renewed = true;
        state.failed = false;
        musicElement.src = url;
        musicSeekOnLoad(state.at);
        if (playing) musicResume();
        return musicControls();
      }
      notice(
        code === 3 || code === 4
          ? "This track cannot play here. Its format may not be supported."
          : "Playback was interrupted. Press Play to continue.",
        true,
        { id: "music" },
      );
    },
    (error) => serial === musicSerial && notice(error.message, true, { id: "music" }),
  );
}
const musicScope = () => `${status?.id}:${status?.hubId || ""}`;
function musicPlayable() {
  return (
    musicPlayer.scope === musicScope() &&
    musicAvailable(status?.volumes?.find((item) => item.id === musicPlayer.volume))
  );
}
function stopMusic() {
  musicSerial++;
  if (musicElement) {
    musicElement.pause();
    musicElement.removeAttribute("src");
    musicElement.load();
  }
  musicPlayer = null;
  renderPlayer();
  try {
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
  } catch {}
  musicLibraries.clear();
  musicCovers.clear();
  musicFailures.clear();
}
function musicRequeue(volume, library) {
  const state = musicPlayer;
  if (state?.volume !== volume) return;
  const playing = state.order[state.position];
  const moved = new Map();
  const tracks = [];
  state.tracks.forEach((track, index) => {
    const fresh = library.tracks.get(track.path) || (index === playing ? track : null);
    if (!fresh) return;
    moved.set(index, tracks.length);
    tracks.push(fresh);
  });
  const before = state.tracks[playing];
  if (state.positions) state.positions = state.positions.filter((_, index) => moved.has(index));
  state.tracks = tracks;
  state.order = state.order.filter((index) => moved.has(index)).map((index) => moved.get(index));
  state.position = state.order.indexOf(moved.get(playing));
  const after = musicCurrent();
  if (["title", "artist", "album", "cover"].some((name) => before[name] !== after[name])) {
    renderPlayer();
    musicSession();
  } else musicControls();
}
function musicStep(direction, ended = false) {
  const state = musicPlayer;
  if (!state) return;
  let next = state.position + direction;
  if (next >= state.order.length) {
    if (state.repeat !== "all") return void (ended && musicControls());
    next = 0;
  }
  if (next < 0) next = state.repeat === "all" ? state.order.length - 1 : 0;
  state.position = next;
  void musicLoad();
}
function musicEnded() {
  if (musicPlayer?.repeat !== "one") return musicStep(1, true);
  musicElement.currentTime = 0;
  musicResume();
}
function musicPrevious() {
  if (!musicPlayer) return;
  if ((musicElement?.currentTime || 0) > 3) musicElement.currentTime = 0;
  else musicStep(-1);
}
function musicPlayerButton(action, label, symbol, pressed = null, disabled = false, cls = "ghost") {
  return `<button type="button" class="${cls} icon-button" data-player="${action}" data-symbol="${symbol}" data-tooltip="${label}" aria-label="${label}"${pressed === null ? "" : ` aria-pressed="${pressed}"`}${disabled ? " disabled" : ""}>${icon(symbol)}</button>`;
}
function patchPlayerButtons(markup) {
  const fresh = document.createElement("div");
  fresh.innerHTML = markup;
  for (const next of fresh.children)
    for (const old of document.querySelectorAll(`#music-player [data-player="${next.dataset.player}"], #music-mini [data-player="${next.dataset.player}"]`)) {
      for (const name of ["aria-label", "aria-pressed", "data-tooltip"])
        if (next.hasAttribute(name)) old.setAttribute(name, next.getAttribute(name));
      old.disabled = next.disabled;
      if (old.dataset.symbol !== next.dataset.symbol) {
        old.dataset.symbol = next.dataset.symbol;
        old.innerHTML = icon(next.dataset.symbol);
      }
    }
  icons();
}
function musicToggleButton(cls) {
  const playing = !musicAudio().paused && !musicPlayer.failed;
  return musicPlayerButton("toggle", playing ? "Pause" : "Play", playing ? "pause" : "play", null, false, cls);
}
function musicNextButton() {
  const last = musicPlayer.position >= musicPlayer.order.length - 1 && musicPlayer.repeat !== "all";
  return musicPlayerButton("next", "Next", "skip-forward", null, last);
}
function musicControlButtons() {
  const state = musicPlayer;
  return (
    musicPlayerButton("shuffle", "Shuffle", "shuffle", state.shuffle) +
    musicPlayerButton("previous", "Previous", "skip-back") +
    musicToggleButton("primary music-play") +
    musicNextButton() +
    musicPlayerButton(
      "repeat",
      { off: "Repeat", all: "Repeat all", one: "Repeat one" }[state.repeat],
      state.repeat === "one" ? "repeat-1" : "repeat",
      state.repeat !== "off",
    )
  );
}
function musicControls() {
  if (!musicPlayer) return;
  patchPlayerButtons(musicControlButtons());
  musicBroadcast();
  if (navigator.mediaSession)
    try {
      navigator.mediaSession.playbackState = musicAudio().paused ? "paused" : "playing";
    } catch {}
}
function musicProgress() {
  const root = $("#music-player");
  const track = musicCurrent();
  if (!root || !track) return;
  const audio = musicAudio();
  const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : track.duration || 0;
  const elapsed = Math.min(audio.currentTime || 0, total || Infinity);
  const seek = root.querySelector('[data-player="seek"]');
  if (!seek) return;
  seek.max = String(total || 1);
  seek.value = String(elapsed);
  seek.setAttribute("aria-valuetext", `${musicClock(elapsed)} of ${musicClock(total)}`);
  seek.style.setProperty("--music-fill", `${total ? (elapsed / total) * 100 : 0}%`);
  root.querySelector('[data-music-time="elapsed"]').textContent = musicClock(elapsed);
  root.querySelector('[data-music-time="total"]').textContent = musicClock(total);
}
function musicLevel() {
  const root = $("#music-player");
  const audio = musicAudio();
  const level = audio.muted ? 0 : audio.volume;
  const input = root?.querySelector('[data-player="volume"]');
  if (!input) return;
  input.value = String(level);
  input.style.setProperty("--music-fill", `${level * 100}%`);
  patchPlayerButtons(musicMuteButton(level));
}
const musicMuteButton = (level) =>
  musicPlayerButton("mute", level ? "Mute" : "Unmute", level ? (level < 0.5 ? "volume-1" : "volume-2") : "volume-x");
function renderMini(track) {
  const card = $("#music-mini");
  if (!card) return;
  if (!track) return void (card.innerHTML = "");
  const cover = musicCover(musicPlayer.volume, track.cover, "music");
  if (card.querySelector(".music-mini-track")) {
    card.querySelector(".music-mini-track > .music-cover").outerHTML = cover;
    patchPlayerButtons(musicToggleButton() + musicNextButton());
  } else
    card.innerHTML = `<button type="button" class="music-mini-track" data-player="show">${cover}<span class="music-mini-text"><strong></strong><span></span></span></button>${musicToggleButton("primary music-mini-play")}${musicNextButton()}`;
  const open = card.querySelector(".music-mini-track");
  open.setAttribute("aria-label", `${track.title} by ${track.artist}, open ${track.album}`);
  open.dataset.tooltip = `Open ${track.album}`;
  open.querySelector("strong").textContent = track.title;
  open.querySelector(".music-mini-text > span").textContent = track.artist;
  icons();
}
const musicInLibrary = () =>
  view === "folders" && folderTab === "library" && musicAvailable(status?.volumes?.find((item) => item.id === detailId));
function placeMusic() {
  const loaded = !!musicCurrent();
  const library = loaded && musicInLibrary();
  $("#music-player")?.classList.toggle("music-elsewhere", loaded && !library);
  const card = $("#music-mini");
  if (card) card.hidden = !loaded || library;
}
let musicBroadcastKey = "";
function musicBroadcast(force = false) {
  if (!native || !window.__TAURI__?.event) return;
  const track = musicCurrent();
  if (track && musicPlayer.loading) return;
  const payload = track
    ? {
        title: track.title,
        artist: track.artist,
        album: track.album,
        folder: musicPlayer.volume,
        cover: track.cover,
        playing: !musicAudio().paused && !musicPlayer.failed,
        next: musicPlayer.position < musicPlayer.order.length - 1 || musicPlayer.repeat === "all",
      }
    : null;
  const key = JSON.stringify(payload);
  if (!force && key === musicBroadcastKey) return;
  musicBroadcastKey = key;
  window.__TAURI__.event.emit("music-state", payload)?.catch?.(() => {});
}
function musicPlayPause() {
  if (!musicPlayer) return;
  const audio = musicAudio();
  if (audio.paused || musicPlayer.failed) musicResume();
  else audio.pause();
}
async function musicShowAlbum() {
  const track = musicCurrent();
  if (track) await musicReveal({ tab: "albums", artist: null, album: track.albumId, playlist: null, pages: 1, trail: [] });
}
async function musicShowArtist() {
  const track = musicCurrent();
  if (!track) return;
  const library = musicLibraries.get(musicKey(musicPlayer.volume))?.library;
  const named = artistId(track.artist);
  const artist =
    library?.artists.find((item) => item.id === named) ||
    library?.artists.find((item) => item.albums.some((album) => album.id === track.albumId));
  await musicReveal({ tab: "artists", artist: artist?.id || named, album: null, playlist: null, pages: 1, trail: [] });
}
async function musicReveal(next) {
  view = "folders";
  detailId = folderViewId = musicPlayer.volume;
  folderTab = "library";
  folderPrefix = "";
  folderSearch = "";
  folderSearchOpen = false;
  folderPageCount = 1;
  folderReturn = { tab: "files", scroll: 0 };
  musicView = next;
  musicQuery = musicSearch();
  await render();
  updateShell();
  $('#music-player [data-player="toggle"]')?.focus();
}
function renderPlayer() {
  const root = $("#music-player");
  if (!root) return;
  const track = musicCurrent();
  root.hidden = !track;
  renderMini(track);
  placeMusic();
  musicBroadcast();
  if (!track) return void (root.innerHTML = "");
  const cover = musicCover(musicPlayer.volume, track.cover, "music");
  const fresh = !root.querySelector(".music-player-track");
  if (fresh)
    root.innerHTML = `<div class="music-player-track"><button type="button" class="music-player-cover" data-player="show" tabindex="-1" aria-hidden="true">${cover}</button><div><button type="button" class="music-player-title" data-player="show"><strong></strong></button><p><button type="button" class="music-player-link" data-player="artist"></button> · <button type="button" class="music-player-link" data-player="show"></button></p></div></div><div class="music-player-center"><div class="music-player-controls">${musicControlButtons()}</div><div class="music-seek"><span class="mono" data-music-time="elapsed">0:00</span><input type="range" class="music-range" data-player="seek" aria-label="Seek" min="0" max="1" step="any" value="0"><span class="mono" data-music-time="total">0:00</span></div></div><div class="music-player-volume">${musicMuteButton(1)}<input type="range" class="music-range" data-player="volume" aria-label="Volume" min="0" max="1" step="0.01" value="1"></div>`;
  else {
    root.querySelector(".music-player-cover > .music-cover").outerHTML = cover;
    patchPlayerButtons(musicControlButtons());
  }
  const title = root.querySelector(".music-player-title");
  title.querySelector("strong").textContent = track.title;
  title.setAttribute("aria-label", `${track.title}, open ${track.album}`);
  title.dataset.tooltip = `Open ${track.album}`;
  const [artist, album] = root.querySelectorAll(".music-player-link");
  artist.textContent = track.artist;
  artist.dataset.tooltip = `Open ${track.artist}`;
  album.textContent = track.album;
  album.dataset.tooltip = `Open ${track.album}`;
  if (fresh) icons();
  mountMusicCovers();
  musicProgress();
  if (fresh) musicLevel();
}
function markMusicPlaying() {
  const track = musicCurrent();
  const position = track && musicPlayer.context.kind === "playlist" ? musicPlayer.positions?.[musicPlayer.order[musicPlayer.position]] : null;
  for (const list of document.querySelectorAll(".music-tracks")) {
    const here = !!track && list.dataset.volume === musicPlayer.volume;
    const ordered = here && position != null && list.dataset.playlist === musicPlayer.context.id;
    for (const row of list.querySelectorAll(".music-track[data-path]")) {
      const playing = here && (ordered ? row.dataset.position === String(position) : row.dataset.path === track.path);
      row.classList.toggle("playing", playing);
      if (playing) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }
}
function musicSession() {
  const session = navigator.mediaSession;
  const track = musicCurrent();
  if (!session || !track) return;
  try {
    if (typeof MediaMetadata === "function") {
      const cover = track.cover && musicCovers.get(new URLSearchParams({ volume: musicPlayer.volume, key: track.cover }).toString());
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: cover ? [{ src: cover, sizes: "360x360", type: "image/jpeg" }] : [],
      });
    }
  } catch {}
  if (musicSessionReady) return;
  musicSessionReady = true;
  for (const [name, run] of [
    ["play", () => musicResume()],
    ["pause", () => musicElement?.pause()],
    ["previoustrack", () => musicPrevious()],
    ["nexttrack", () => musicStep(1)],
  ])
    try {
      session.setActionHandler(name, run);
    } catch {}
}
document.addEventListener("click", (event) => {
  const control = event.target.closest?.("#music-player [data-player], #music-mini [data-player]");
  if (!control || control.disabled || !musicPlayer) return;
  const audio = musicAudio();
  const name = control.dataset.player;
  if (name === "toggle") musicPlayPause();
  else if (name === "show") void navigate(musicShowAlbum);
  else if (name === "artist") void navigate(musicShowArtist);
  else if (name === "previous") musicPrevious();
  else if (name === "next") musicStep(1);
  else if (name === "shuffle") {
    const current = musicPlayer.order[musicPlayer.position];
    musicPlayer.shuffle = !musicPlayer.shuffle;
    musicPlayer.order = musicPlayer.shuffle
      ? shuffleOrder(musicPlayer.tracks.length, current)
      : musicPlayer.tracks.map((_, index) => index);
    musicPlayer.position = musicPlayer.shuffle ? 0 : current;
    musicControls();
  } else if (name === "repeat") {
    musicPlayer.repeat = nextRepeat(musicPlayer.repeat);
    musicControls();
  } else if (name === "mute") {
    audio.muted = !audio.muted && audio.volume > 0;
    if (!audio.muted && !audio.volume) audio.volume = 1;
    musicLevel();
  }
});
document.addEventListener("input", (event) => {
  const control = event.target;
  if (control.id === "music-search-input") return void musicSearchInput(control.value);
  if (!control.matches?.("#music-player [data-player]") || !musicPlayer) return;
  const audio = musicAudio();
  if (control.dataset.player === "seek") {
    audio.currentTime = Number(control.value);
    musicProgress();
  }
  if (control.dataset.player === "volume") {
    audio.volume = Number(control.value);
    audio.muted = false;
    try {
      localStorage.setItem("arca-music-volume", String(audio.volume));
    } catch {}
    musicLevel();
  }
});
async function handleMusic(name, id) {
  const v = status.volumes.find((item) => item.id === detailId);
  if (!musicAvailable(v)) return;
  const page = () => $("#content .music-page");
  if (name === "music-mode") {
    if (folderTab === "library") folderTab = folderReturn.tab;
    else {
      folderReturn = { tab: folderTab, scroll: $(".page")?.scrollTop || 0 };
      folderTab = "library";
    }
    await render();
    if (folderTab !== "library" && $(".page")) $(".page").scrollTop = folderReturn.scroll;
    return;
  }
  if (name === "music-retry") {
    musicFailures.delete(musicKey(v.id));
    await render();
    return;
  }
  let library = musicLibraries.get(musicKey(v.id))?.library;
  if (!library) {
    await refreshMusic(v.id, true);
    library = musicLibraries.get(musicKey(v.id))?.library;
  }
  if (!library) return;
  const random = (length) => Math.floor(Math.random() * length);
  if (name === "music-song") {
    const track = library.tracks.get(id);
    const album = track && library.albums.get(track.albumId);
    if (!album) return;
    return musicStart(
      v.id,
      { kind: "album", id: album.id, name: album.title },
      album.tracks,
      album.tracks.indexOf(track),
      !!musicPlayer?.shuffle,
    );
  }
  if (name === "music-shuffle-all") {
    const tracks = library.albumList.flatMap((album) => album.tracks);
    return musicStart(v.id, { kind: "library", id: v.id, name: v.name }, tracks, random(tracks.length), true);
  }
  if (name === "music-shuffle-artist") {
    const artist = library.artists.find((item) => item.id === musicView.artist);
    if (!artist) return;
    const tracks = artist.albums.flatMap((album) => album.tracks);
    return musicStart(v.id, { kind: "artist", id: artist.id, name: artist.name }, tracks, random(tracks.length), true);
  }
  if (name === "music-search-toggle") {
    const opening = !musicQuery.open;
    musicQuery = musicSearch(opening);
    renderMusic(v, page()?.scrollTop || 0);
    $(opening ? "#music-search-input" : '[data-action="music-search-toggle"]')?.focus();
    return;
  }
  if (name === "music-search-apply") return musicSearchInput($("#music-search-input")?.value || "");
  if (name === "music-search-more") {
    if (["songs", "albums", "artists"].includes(id)) musicQuery = { ...musicQuery, [id]: musicQuery[id] + 1 };
    renderMusic(v, page()?.scrollTop || 0);
    return;
  }
  if (["music-track", "music-play", "music-shuffle"].includes(name)) {
    const album = musicView.album && library.albums.get(musicView.album);
    const list = !album && musicView.playlist && library.playlists.find((item) => item.id === musicView.playlist);
    const item = album || list;
    if (!item?.tracks.length) return;
    const start =
      name === "music-track"
        ? Math.min(Math.max(Number(id) || 0, 0), item.tracks.length - 1)
        : name === "music-shuffle"
          ? random(item.tracks.length)
          : 0;
    const shuffle = name === "music-shuffle" || (name === "music-track" && !!musicPlayer?.shuffle);
    return musicStart(
      v.id,
      album ? { kind: "album", id: album.id, name: album.title } : { kind: "playlist", id: list.id, name: list.name },
      item.tracks,
      start,
      shuffle,
      list ? list.positions : null,
    );
  }
  const playlist = (path) => library.playlists.find((item) => item.id === path);
  const edit = (body) => api("/v1/music/playlist", { volume: v.id, ...body });
  if (name === "music-add") {
    const track = library.tracks.get(id);
    if (!track) return;
    musicPicking = track.path;
    modal(
      modalHeader("Add to playlist", escape(`${track.title} · ${track.artist}`), "list-plus") +
        `<div class="history-group music-picker">${library.playlists
          .filter((list) => list.editable)
          .map((list) => musicRow(v, "music-pick", list.id, list.cover, list.name, musicCount(list.entries.length, "track"), "list-music"))
          .join("")}${musicRow(v, "music-pick-new", track.path, null, "New playlist…", "Saved as a file in Playlists/", "plus")}</div>`,
      async () => {},
      "Add",
    );
    $("#submit-dialog").hidden = true;
    return;
  }
  if (name === "music-pick") {
    const list = playlist(id);
    if (!list || !musicPicking) return;
    $("#dialog").close();
    await edit({ action: "add", path: list.id, hash: list.hash, track: musicPicking });
    notice(`Added to ${list.name}`);
    await refreshMusic(v.id, true);
    return;
  }
  if (name === "music-pick-new") {
    const track = id;
    modal(
      modalHeader("New playlist", "Saved as a file in Playlists/ and synced to every device.", "list-plus") +
        textField("Name", "name", "", "list-music"),
      async (form) => {
        const created = await edit({ action: "create", name: form.get("name"), track });
        notice(`Added to ${created.path.slice(created.path.indexOf("/") + 1).replace(/\.m3u8$/i, "")}`);
        await refreshMusic(v.id, true);
        armMusicIndex(v.id);
      },
      "Create playlist",
    );
    return;
  }
  if (name === "music-remove") {
    const list = playlist(musicView.playlist);
    const entry = list?.entries[Number(id)];
    if (!entry) return;
    await edit({ action: "remove", path: list.id, hash: list.hash, position: entry.position, track: entry.path });
    await refreshMusic(v.id, true);
    return;
  }
  if (name === "music-playlist-rename") {
    const list = playlist(id);
    if (!list) return;
    modal(
      modalHeader("Rename playlist", "Changes its name and its file in Playlists/ on every device.", "pencil") +
        textField("Name", "name", list.name, "list-music"),
      async (form) => {
        const renamed = await edit({ action: "rename", path: list.id, hash: list.hash, name: form.get("name") });
        renameMusicHistory(v.id, list.id, renamed.path);
        musicView = { ...musicView, playlist: renamed.path };
        await refreshMusic(v.id, true);
      },
      "Rename",
    );
    return;
  }
  if (name === "music-playlist-delete") {
    const list = playlist(id);
    if (!list) return;
    modal(
      modalHeader("Delete playlist?", escape(`Deletes ${list.id} on every device. You can restore it from History.`), "trash-2"),
      async () => {
        await edit({ action: "delete", path: list.id, hash: list.hash });
        const previous = musicView.trail.at(-1) || { pages: 1 };
        musicView = { ...musicView, playlist: null, pages: previous.pages, trail: musicView.trail.slice(0, -1) };
        await refreshMusic(v.id, true);
      },
      "Delete playlist",
    );
    $("#submit-dialog").classList.add("danger");
    return;
  }
  let scroll = 0;
  if (name === "music-tab") {
    musicView = { tab: MUSIC_TABS[id] ? id : "artists", artist: null, album: null, playlist: null, pages: 1, trail: [] };
    musicQuery = musicSearch();
  }
  else if (name === "music-more") {
    musicView.pages++;
    scroll = page()?.scrollTop || 0;
  } else if (name === "music-back") {
    const previous = musicView.trail.at(-1) || { pages: 1, scroll: 0 };
    musicView = {
      ...musicView,
      ...(musicView.album || musicView.playlist ? { album: null, playlist: null } : { artist: null }),
      pages: previous.pages,
      trail: musicView.trail.slice(0, -1),
    };
    scroll = previous.scroll;
  } else if (["music-album", "music-artist", "music-playlist"].includes(name))
    musicView = {
      ...musicView,
      [name.slice(6)]: id,
      pages: 1,
      trail: [...musicView.trail, { pages: musicView.pages, scroll: page()?.scrollTop || 0 }],
    };
  else return;
  renderMusic(v, scroll);
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
    folderTab = v.gallery ? "gallery" : musicAvailable(v) ? "library" : "files";
    folderPrefix = "";
    folderSearch = "";
    folderSearchOpen = false;
    folderPageCount = 1;
    folderReturn = { tab: "files", scroll: 0 };
    musicView = { tab: "artists", artist: null, album: null, pages: 1, trail: [] };
    musicQuery = musicSearch();
    const cached = musicLibraries.get(musicKey(v.id));
    if (cached) cached.checked = 0;
  }
  if (folderTab === "library" && !musicAvailable(v)) folderTab = "files";
  placeMusic();
  if (folderTab === "library") {
    renderMusic(v);
    void refreshMusic(v.id);
    return;
  }
  if (folderTab === "gallery") {
    // The photo grid does not depend on activity, file browsing or copy reports.
    $("#content").innerHTML =
      `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}${title(escape(v.name), `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)}`, galleryModeButton(v) + folderActionsMenu(v))}</div><div class="page detail-page gallery-page">${await folderBrowser(v, [])}</div>`;
    $("#content").dataset.detail = v.id;
    icons();
    mountGallery(v.id);
    return;
  }
  if (status.role !== "hub" && !status.hub) {
    $("#content").innerHTML =
      `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}${title(escape(v.name), `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)} local`, (native && v.path && folderTab !== "gallery" ? button(status.platform === "darwin" ? "Open in Finder" : "Open folder", "open", v.id, "secondary", "external-link") : "") + galleryModeButton(v) + musicModeButton(v) + folderActionsMenu(v))}</div><div class="page detail-page ${folderTab === "gallery" ? "gallery-page" : ""}">${folderTab === "gallery" ? "" : section("Hub connection", hubConnection()) + `<div class="stats">${folderRetentionSummary(v)}</div>`}${await folderBrowser(v, [])}</div>`;
    icons();
    if (folderTab === "gallery") mountGallery(v.id);
    return;
  }
  if (!pending && $("#content").dataset.detail !== detailId)
    await renderDetail(true);
  const recentRoute = `/v1/activity?volume=${encodeURIComponent(v.id)}&limit=4`;
  const known = knownFolderPage(recentRoute)?.versions;
  const shownSaved = !!recentSaved.get(v.id);
  // Recent needs the hub; local files must not wait for it.
  const recentRead = pending
    ? null
    : readFolderPage(recentRoute).then(
        (page) => {
          recentSaved.set(v.id, !!page?.offline);
          recentFailed.delete(v.id);
          return page?.versions || known || [];
        },
        () => {
          if (!known) recentFailed.add(v.id);
          return known || [];
        },
      );
  const current = () =>
    view === "folders" && detailId === v.id && serial === renderSerial;
  const lastChangeCell = (recent) => {
    if (!recent)
      return `<strong>${scaffoldLine("short")}</strong><p>${scaffoldLine("medium")}</p>`;
    const row = recent[0];
    const saved = !!recentSaved.get(v.id);
    if (!row)
      return recentFailed.has(v.id)
        ? "<strong>Not available</strong><p>Try again when the hub is reachable</p>"
        : saved
          ? "<strong>No saved versions</strong><p>Connect to the hub for the newest</p>"
          : "<strong>No changes yet</strong><p>Accepted by the hub</p>";
    return `<strong>${relative(row.created)}</strong><p>${escape(row.path.split("/").pop())} · ${escape(authorName(row.author))}${saved ? " · last known" : ""}</p>`;
  };
  const browser = await folderBrowser(v, known, pending);
  if (!current()) return;
  const state = stateFor(v);
  const unscanned =
    !Number.isFinite(v.files) ||
    (v.sync?.state === "error" && !v.sync.lastCompleted);
  $("#content").innerHTML =
    `<div class="detail-head">${button("Folders", "back-folders", "", "back", "chevron-left")}<div class="heading"><div class="detail-title"><div class="tile large">${icon(folderSymbol(v))}</div><div><h1>${escape(v.name)}</h1><p>${unscanned ? "Not counted yet" : `${(v.files || 0).toLocaleString("en")} files · ${bytes(v.bytes || 0)} ${v.path ? "local" : "on hub"}`}</p></div></div><div class="heading-actions">${native && v.path && folderTab !== "gallery" ? button(status.platform === "darwin" ? "Open in Finder" : "Open folder", "open", v.id, "secondary", "external-link") : ""}${galleryModeButton(v)}${musicModeButton(v)}${folderActionsMenu(v)}</div></div></div><div class="page detail-page ${folderTab === "gallery" ? "gallery-page" : ""}"><div class="stats folder-stats"><div class="stat"><span>Status</span><strong class="stat-status ${state[1]}">${state[2] === "busy" ? busyIcon() : icon(state[2])}${escape(state[0])}</strong><p>${v.sync?.lastCompleted ? `Completed ${relative(v.sync.lastCompleted)}` : "No completed sync yet"}</p></div><div class="stat stat-last-change"><span>Last change</span>${lastChangeCell(known)}</div>${folderRetentionSummary(v)}</div><div class="detail-grid"><div class="detail-revisions">${browser}</div><div class="detail-side">${section(status.role === "hub" ? `Path on ${escape(status.name)}` : "Local destination", `<div class="panel"><p class="path">${escape(v.path || "Not on this device")}</p>${native && status.role !== "hub" && v.path ? button("Change location…", "move-folder", v.id, "secondary small-button", "folder-input") : ""}</div>`)}${section("Copies", '<div class="copies-card" id="folder-copies"></div>')}${status.role === "hub" ? section("Version history", folderRetentionPanel(v)) : ""}<div class="panel"><h3>${status.role === "hub" ? "Hub working copy" : `Stop syncing on ${machineLabel()}`}</h3><p>${status.role === "hub" ? "Controls this hub’s folder on disk. Stopping it keeps the shared folder and history available to other devices; files remain on disk." : "Stops syncing this folder here. The hub keeps the shared folder, its files and history."}</p>${button(v.selected ? (status.role === "hub" ? "Stop syncing here…" : "Stop syncing…") : "Start syncing", v.selected ? "unselect" : "add", v.id, v.selected ? "secondary danger" : "secondary", v.selected ? "unlink" : "refresh-cw")}</div>${status.role === "hub" ? `<div class="panel"><h3>Delete shared folder</h3><p>Stops sharing on all devices and deletes this shared folder’s history from the hub. Physical files and existing backups are kept.</p>${button("Delete shared folder…", "delete-share", v.id, "secondary danger", "trash-2")}</div>` : ""}</div></div></div>`;
  $("#content").dataset.detail = v.id;
  refreshCopies();
  if (!pending && folderTab === "gallery") mountGallery(v.id);

  // Patch only what depends on Recent, so scrolling, focus and typed search survive.
  void recentRead?.then(async (recent) => {
    if (
      !current() ||
      (JSON.stringify(recent) === JSON.stringify(known) &&
        !!recentSaved.get(v.id) === shownSaved)
    )
      return;
    const cell = $("#content .folder-stats .stat-last-change");
    if (cell) cell.innerHTML = `<span>Last change</span>${lastChangeCell(recent)}`;
    if (folderTab !== "recent") return;
    const browser = await folderBrowser(v, recent);
    const target = $("#content .detail-revisions");
    if (current() && folderTab === "recent" && target) {
      const next = document.createElement("div");
      next.innerHTML = browser;
      next.querySelector(".folder-browser-tools")?.remove();
      for (const child of [...target.children])
        if (!child.matches(".folder-browser-tools")) child.remove();
      target.append(...next.childNodes);
      icons();
    }
  });
}
const pad2 = (n) => String(n).padStart(2, "0");
const localDay = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const dayLong = (key) =>
  new Date(`${key}T12:00:00`).toLocaleDateString("en", { month: "short", day: "numeric" });
const changeLabel = (n) => countLabel(n, "change");
function activityDevices(devices) {
  return Object.entries(devices || {}).sort((a, b) => b[1] - a[1]);
}
function deviceCounts(devices) {
  return activityDevices(devices)
    .map(
      ([id, n]) =>
        `<span class="act-dev">${icon(id === (status.role === "hub" ? status.id : status.hubId) ? "server" : "monitor-smartphone")}${escape(authorName(id))} ${n}</span>`,
    )
    .join("");
}
function historyStrip() {
  if (!historyDays) return "";
  const byDay = new Map(historyDays.days.map((d) => [d.day, d]));
  const keys = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(localDay(d));
  }
  const max = Math.max(1, ...keys.map((k) => byDay.get(k)?.changes || 0));
  const bars = keys
    .map((key, index) => {
      const entry = byDay.get(key);
      const n = entry?.changes || 0;
      const level = n ? Math.max(1, Math.ceil((n / max) * 9)) : 0;
      const mark = entry?.conflicts ? " act-conflict" : entry?.deleted ? " act-deleted" : "";
      const today = index === keys.length - 1;
      const label = today ? "Today" : dayLong(key);
      const detail = `${label} · ${changeLabel(n)}${entry?.deleted ? ` · ${entry.deleted} deleted` : ""}${entry?.conflicts ? ` · ${countLabel(entry.conflicts, "conflict")}` : ""}`;
      return `<button type="button" class="act-bar act-h${level}${mark}" data-action="history-day" data-id="${key}" aria-label="${escape(detail)}"${today ? ' aria-current="date"' : ""}><span class="act-tip">${escape(detail)}</span><i></i></button>`;
    })
    .join("");
  return `<div class="act-strip"><div class="act-strip-head"><div class="section-label">Last 30 days</div><div class="act-legend"><span>Changes</span><span class="act-lg-conflict">Conflict</span><span class="act-lg-deleted">Deleted</span></div></div><div class="act-bars">${bars}</div><div class="act-axis"><span>${dayLong(keys[0])}</span><span>${dayLong(keys[15])}</span><span class="act-today">Today</span></div></div>`;
}
function awayBanner() {
  if (!awayNotice) return "";
  const when = dayLabel(awayNotice.since);
  const phrase = when === "Today" ? "today" : when === "Yesterday" ? "yesterday" : when;
  const devices = activityDevices(awayNotice.devices)
    .map(([id, n]) => `${escape(authorName(id))} ${n}`)
    .join(" · ");
  return `<div class="act-away" role="status"><div class="tile">${icon("history")}</div><div class="act-text"><strong>Changed while you were away</strong><p>Since ${phrase} ${clockTime(awayNotice.since)} · ${changeLabel(awayNotice.changes)}${devices ? ` · ${devices}` : ""}</p></div>${button("Show", "history-away-show", "", "secondary small-button")}<button type="button" class="ghost icon-button" data-action="history-away-dismiss" aria-label="Dismiss">${icon("x")}</button></div>`;
}
const AWAY_MS = 4 * 3600000;
const awayKey = () => `arca-history-seen:${status?.hubId || status?.id || ""}`;
function markSeen() {
  try {
    localStorage.setItem(awayKey(), String(Date.now()));
  } catch {
    /* Private storage only disables the away banner. */
  }
}
async function checkAway() {
  if (!status?.id) return;
  let last = 0;
  try {
    last = Number(localStorage.getItem(awayKey()) || 0);
  } catch {
    return;
  }
  if (!last || Date.now() - last < AWAY_MS) {
    markSeen();
    return;
  }
  const since = new Date(last).toISOString();
  try {
    const data = await api(
      `/v1/activity-days?days=1&offset=${new Date().getTimezoneOffset()}&since=${encodeURIComponent(since)}`,
    );
    if (!data.since) return;
    markSeen();
    if (!data.since.changes) return;
    awayNotice = { since, ...data.since };
    if (view === "history" && !historyPath) await renderHistory();
  } catch {
    /* The banner is optional; the hub may be away. */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) markSeen();
  else checkAway();
});
async function jumpToDay(key) {
  let guard = 0;
  while (
    historyNext &&
    guard++ < 40 &&
    !historyRows.some((r) => localDay(r.created) < key)
  )
    await renderHistory(historyNext, true);
  const target = [...document.querySelectorAll("#history-list section[data-day]")].find(
    (el) => el.dataset.day <= key,
  );
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  target.classList.add("act-landed");
  setTimeout(() => target.classList.remove("act-landed"), 2000);
}
function showAway() {
  const since = awayNotice && Date.parse(awayNotice.since);
  if (!since) return;
  const rows = [...document.querySelectorAll("#history-list .history-row")];
  const index = historyRows.findLastIndex((r) => Date.parse(r.created) > since);
  (rows[Math.max(0, index)] || rows[0])?.scrollIntoView({ block: "start" });
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
        historyLocal = null;
        historyOffline = false;
        list.innerHTML = section("File versions", scaffoldRow("history"));
      }
      return;
    }
    if (!target) list = $("#history-list");
    if (!list) return;
    historyVersions = append
      ? [...historyVersions, ...data.versions]
      : data.versions;
    historyOffline = !!data.offline;
    historyLocal = data.local || null;
    if (data.localOnly) {
      list.innerHTML = section(
        "File versions",
        empty(
          "No saved versions for this file",
          `Offline. Connect to the hub to load its history.${historyVersions[0] ? " Your local file is still available." : ""}`,
        ),
      );
      return;
    }
    list.innerHTML =
      (data.offline
        ? `<p class="hint">${data.truncated ? "Showing saved history · recent entries only. Connect to the hub for updated retention and older versions." : "Showing saved history. Connect to the hub for updated retention."}</p>`
        : "") +
      section(
        "File versions",
        historyVersions.length
          ? `<div class="history-group">${historyVersions.map((v, index) => `<div class="history-row file-version-row">${rowPreview({ ...v, volume: historyVolume, path: historyPath }, v.deleted ? "trash-2" : "git-commit-horizontal", true)}<div><strong>${date(v.created)}</strong><p>${v.deleted ? "Deleted file" : bytes(v.size)} · ${escape(authorName(v.author))}</p></div><span class="mono revision">rev ${v.rev}</span><div class="row-actions">${index === 0 ? pill("Current", "id", "check") : v.deleted ? "" : button("Restore", "restore", String(v.rev), "text-button", "undo-2")}</div></div>`).join("")}</div>`
          : data.offline
            ? empty(
                "No saved versions for this file",
                "Offline. Connect to the hub to load its history.",
              )
            : empty(
                "No retained versions",
                "This file has no history available on the hub.",
              ),
      ) +
      `${data.next ? `<div class="pagination">${button("Show more versions", "history-page", data.next, "secondary")}</div>` : ""}`;
    icons();
    return;
  }
  const data = await readHistory(
    `/v1/activity?limit=50&filter=${historyFilter}${historyVolume ? `&volume=${encodeURIComponent(historyVolume)}` : ""}${cursor ? `&before=${cursor}` : ""}`,
  );
  if (!data) {
    if (cached) list.innerHTML = scaffoldRow("history");
    return;
  }
  if (!target) list = $("#history-list");
  if (!list) return;
  if (data.offline && !data.saved && !data.versions.length) {
    list.innerHTML = empty(
      "History unavailable offline",
      "Your local files remain available. Connect to the hub to load their history.",
    );
    return;
  }
  historyRows = append ? [...historyRows, ...data.versions] : data.versions;
  historyNext = data.next;
  if (!append && !cursor) {
    const days = await viewRead(
      `/v1/activity-days?days=30&offset=${new Date().getTimezoneOffset()}${historyVolume ? `&volume=${encodeURIComponent(historyVolume)}` : ""}`,
    ).catch(() => null);
    if (serial !== renderSerial) return;
    historyDays = Array.isArray(days?.days) ? days : null;
    if (!target) list = $("#history-list");
    if (!list) return;
  }
  const groups = new Map();
  for (const r of historyRows) {
    const key = localDay(r.created);
    if (!groups.has(key)) groups.set(key, { day: dayLabel(r.created), rows: [] });
    groups.get(key).rows.push(r);
  }
  const summaries = new Map(
    (historyFilter === "revisions" ? historyDays?.days || [] : []).map((d) => [d.day, d]),
  );
  list.innerHTML =
    awayBanner() +
    (historyRows.length && historyFilter === "revisions" ? historyStrip() : "") +
    (data.offline
      ? '<p class="hint">Showing saved history · recent entries only. Connect to the hub for updated retention and older versions.</p>'
      : "") +
    (historyRows.length
      ? [...groups]
          .map(([key, { day, rows }]) => {
            const entry = summaries.get(key);
            const summary = entry
              ? `<span class="act-summary"><b>${changeLabel(entry.changes)}</b>${deviceCounts(entry.devices)}</span>`
              : "";
            return `<section data-day="${key}"><div class="section-label">${day}${summary}</div><div class="history-group">${rows.map((v) => revisionRow(v)).join("")}</div></section>`;
          })
          .join("") +
        `${historyNext ? `<div class="pagination">${button("Show more", "history-page", historyNext, "secondary")}</div>` : ""}`
      : historyEmpty());
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
  deviceKey = "",
) =>
  `<article class="device-row ${dashed ? "discovered" : ""}${deviceKey && deviceKey === pickedDevice ? " device-picked" : ""}"${deviceKey ? ` data-device="${escape(deviceKey)}"` : ""}><div class="tile large ${hub ? "hub" : ""}">${icon(hub ? "server" : /ios|android|iphone|ipad/i.test(metadata) ? "smartphone" : "monitor")}</div><div class="row-main"><div class="row-tags"><strong>${escape(name)}</strong>${tags}${self ? '<span class="tag self">This device</span>' : ""}</div><p class="connection-line">${[metadata, description].filter(Boolean).join(" · ")}</p></div><div class="row-end">${state}${totals ? `<span class="hint">${totals}</span>` : ""}</div>${controls}</article>`;

let pickedDevice = "";
const REPORT_FRESH_MS = 300000;
function deviceMap() {
  const known = (roster?.machines || []).filter((m) => !m.isHub && !m.revoked);
  if (!known.length) return "";
  const away =
    status.role !== "hub" && Boolean(status.hubUnavailable || roster?.offline);
  const nodes = known.map((m) => {
    const key = m.credentialId || m.machineId || m.name;
    const at = m.reportedAt && !Number.isNaN(Date.parse(m.reportedAt)) ? m.reportedAt : "";
    const state = !at
      ? "none"
      : Date.now() - Date.parse(at) < REPORT_FRESH_MS
        ? "fresh"
        : "stale";
    return {
      key,
      name: m.name,
      at,
      state,
      self:
        m.machineId === status.id ||
        Boolean(status.deviceId && m.credentialId === status.deviceId),
      symbol: /ios|android|iphone|ipad/i.test(m.platform || "")
        ? "smartphone"
        : "monitor",
    };
  });
  const lined = !away && nodes.length <= 4;
  const x = (i) => ((i + 0.5) * 300) / nodes.length;
  const paths = lined
    ? nodes
        .map((n, i) =>
          n.state === "none"
            ? ""
            : `<path class="topo-link topo-${n.state}" d="${Math.round(x(i)) === 150 ? "M150 0 L150 56" : `M150 0 C150 30 ${x(i)} 26 ${x(i)} 56`}" />`,
        )
        .join("")
    : "";
  const hubNode = `<div class="topo-hub"><div class="topo-node topo-hub-node${away ? " topo-last" : ""}"><span class="tile large hub">${icon("server")}</span><span class="topo-name"><strong>${escape(status.role === "hub" ? status.name : hubName())}</strong><span class="tag hub">Hub</span></span>${away ? pill("Unavailable", "wa", "wifi-off") : ""}</div></div>`;
  const pillFor = (n) =>
    n.state === "none"
      ? pill("No report yet", "id", "circle-dashed")
      : away
        ? n.self
          ? pill("Offline", "wa", "wifi-off")
          : pill(relative(n.at), "id", "circle-dashed")
        : n.state === "fresh"
          ? pill(relative(n.at), "ok", "activity")
          : pill(relative(n.at), "wa", "clock");
  const cards = nodes
    .map(
      (n) =>
        `<button type="button" class="topo-node${away ? " topo-last" : n.state === "none" ? " topo-none" : ""}" data-action="pick-device" data-id="${escape(n.key)}" aria-pressed="${n.key === pickedDevice}">${`<span class="tile large">${icon(n.symbol)}</span>`}<span class="topo-name"><strong>${escape(n.name)}</strong>${n.self ? '<span class="tag self">This device</span>' : ""}</span>${pillFor(n)}</button>`,
    )
    .join("");
  const key = lined
    ? '<div class="topo-key"><span><svg viewBox="0 0 24 4" aria-hidden="true"><line class="topo-link topo-fresh" x1="0" y1="2" x2="24" y2="2" /></svg>Last report under 5 min</span><span><svg viewBox="0 0 24 4" aria-hidden="true"><line class="topo-link topo-stale" x1="0" y1="2" x2="24" y2="2" /></svg>Older report</span><span>No line: never reported</span></div>'
    : "";
  const bridge = away
    ? `<div class="topo-break">${icon("unplug")}Hub unreachable: reports below are the last saved</div>`
    : lined
      ? `<svg class="topo-links" viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`
      : "";
  return `<div class="topo">${hubNode}${bridge}<div class="topo-nodes topo-cols-${Math.min(nodes.length, 4)}">${cards}</div>${key}</div>`;
}
function pickDevice(key) {
  pickedDevice = pickedDevice === key ? "" : key;
  document.querySelectorAll("[data-action=\"pick-device\"]").forEach((node) =>
    node.setAttribute("aria-pressed", String(node.dataset.id === pickedDevice)),
  );
  let target = null;
  document.querySelectorAll(".device-row[data-device]").forEach((row) => {
    const on = row.dataset.device === pickedDevice;
    row.classList.toggle("device-picked", on);
    if (on) target = row;
  });
  target?.scrollIntoView({ block: "nearest" });
}
function selfPill() {
  if (!status.hub) return pill("Disconnected", "wa", "unplug");
  if (status.hubUnavailable && status.phase !== "paused")
    return pill("Offline", "wa", "wifi-off");
  const [label, tone, symbol] = {
    idle: ["Up to date", "ok", "circle-check"],
    paused: ["Paused", "wa", "pause"],
    error: ["Needs attention", "er", "circle-alert"],
  }[status.phase] || ["Syncing", "sy", "busy"];
  return pill(label, tone, symbol);
}
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
  const summary = roster?.offline
    ? '<p class="hint">Offline · showing saved device information · last known</p>'
    : "";
  let machineRows = "";
  const map = deviceMap();
  let html =
    (map ? section("Network", map) : "") +
    (status.role === "replica" ? section("Hub connection", hubConnection()) : "");
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
      `${status.volumes.length} shared folders · ${bytes(status.volumes.reduce((n, v) => n + v.bytes, 0))} on the hub`,
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
      `${countLabel(catalog.length, "shared folder")} on the hub`,
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
      `${roleTag(status.role)}${status.backup?.enabled ? '<span class="tag">Backs up hub</span>' : ""}`,
      selfAddress ? `Tailscale · ${escape(selfAddress)}` : "",
      "",
      selfPill(),
      "",
      true,
      false,
      false,
      escape(platformLabel(status.platform)),
      `${status.volumes.filter((v) => v.selected).length} folders · ${bytes(status.volumes.filter((v) => v.selected).reduce((n, v) => n + v.bytes, 0))} local`,
      status.deviceId || status.id,
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
        ? pill("Removed", "er", "unplug")
        : p?.online === false
          ? pill("Offline", "id", "circle-dashed")
          : !d.last_seen
            ? pill("Invitation only", "wa", "clock")
            : pill("Linked", "id", "link");
      const tags = `${roleTag(d.role)}${d.backup_enabled ? '<span class="tag">Backs up hub</span>' : ""}`;
      records += row(
        report?.name || d.name,
        tags,
        connection(p, d.last_address),
        "",
        state,
        d.revoked
          ? ""
          : `<details class="details-menu"><summary class="icon-button" aria-label="Actions for ${escape(d.name)}">${icon("ellipsis")}</summary><div class="menu-items">${button(status.webApprovers?.includes(d.id) ? "Disable web approval" : "Allow web approval…", "web-approver", d.id, "secondary", "shield-check")}${button("Remove device", "revoke", d.id, "secondary danger", "unplug")}</div></details>`,
        false,
        false,
        !d.last_seen,
        p ? platform(p) : escape(platformLabel(report?.platform || "")),
        "",
        d.id,
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
              roleTag(m.role),
              [
                connection(
                  peers.find(
                    (p) =>
                      p.arca.id === m.machineId ||
                      p.addresses?.includes(m.lastAddress),
                  ),
                  m.lastAddress,
                ),
                roster.offline ? "last known" : "",
              ]
                .filter(Boolean)
                .join(" · "),
              "",
              m.revoked
                ? pill("Removed", "er", "unplug")
                : roster.offline && status.hubUnavailable
                  ? pill("Offline", "id", "circle-dashed")
                  : pill("Linked", "id", "link"),
              "",
              false,
              false,
              false,
              escape(platformLabel(m.platform || "")),
              "",
              m.credentialId || m.machineId || m.name,
            ),
          )
          .join("")
      : roster
        ? ""
        : !fetchData
          ? scaffoldRow()
          : empty(
              "Device list unavailable",
              "Reconnect to the hub to see its devices.",
            );
  }
  html += section("Devices", machineRows);
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
        ? "Detected devices · not authorized"
        : "Detected hubs",
      found
        .map((p) =>
          row(
            p.name,
            roleTag(p.arca.role) || '<span class="tag">Arca</span>',
            connection(p),
            "",
            p.arca.state === "incompatible"
              ? pill("Incompatible Arca", "er", "circle-alert")
              : pill("Arca detected", "id", "circle-dot"),
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
      '<p class="hint">Detection does not connect devices. A pairing code is required.</p>';
  if (issue)
    html += `<p class="hint">Discovery unavailable: ${escape(issue)}</p>`;
  if (status.role === "hub" || status.hub)
    html += section("Hub backup", backupSummary());
  $("#content").innerHTML =
    title(
      "Devices",
      summary,
      status.role === "hub"
        ? button("Pair a device", "invite", "", "primary", "key-round")
        : "",
    ) + `<div class="page" id="devices-list">${html}</div>`;
  icons();
}
function backupActivity() {
  const p = status.backup?.progress;
  return p
    ? `Copying history${p.revisions ? ` · ${countLabel(p.revisions, "version")}` : ""}`
    : "";
}
function backupCompletionSetting() {
  const backup = status.backup || {};
  return setting(
    "Last completed backup",
    backupActivity() ||
      `${date(backup.lastSync)}${!backup.lastSync || backup.contentBytes == null ? "" : ` · ${bytes(backup.contentBytes)}`}${backup.waiting ? " · Waiting for the hub" : backup.error ? ` · ${escape(backup.error)}` : ""}`,
    backup.progress
      ? pill("Running", "sy", "busy")
      : backup.waiting
        ? pill("Offline", "wa", "wifi-off")
        : pill(
            backup.error
              ? "Needs attention"
              : backup.enabled
                ? backup.lastSync
                  ? "Completed"
                  : "Pending"
                : "Off",
            backup.error ? "er" : "id",
            "shield",
          ),
  ).replace("<div ", '<div id="backup-completion" ');
}
function backupSummary() {
  if (status.role !== "hub")
    return `<div class="backup-card">${icon(status.backup?.enabled ? "shield-check" : "shield-off")}<div class="row-main"><strong>${status.backup?.enabled ? "On this device" : "Off on this device"}</strong><p>${status.backup?.enabled ? (status.backup.progress ? backupActivity() : status.backup.waiting ? "Waiting for the hub to continue." : status.backup.error ? `Needs attention: ${escape(status.backup.error)}` : status.backup.lastSync ? `${status.backup.folders || 0} folders · ${Number(status.backup.revisions || 0).toLocaleString()} versions · Last completed ${relative(status.backup.lastSync)}` : "Waiting for the first completed backup") : "Keep a full copy of the hub and its history."}</p></div>${button("Backup settings", "backup-settings", "", "secondary small-button")}</div>`;
  const a = status.devices.filter((d) => !d.revoked && d.backup_enabled);
  return a.length
    ? a
        .map(
          (d) =>
            `<div class="backup-card">${icon("shield-check")}<div class="row-main"><strong>${escape(d.name)} backs up this hub</strong><p>${d.backup_updated ? `Last report ${date(d.backup_updated)} · history rev ${d.backup_revision || 0}` : "Waiting for the first backup report."}</p></div>${pill(d.backup_updated ? "Reported" : "Pending", "id", "clock")}</div>`,
        )
        .join("")
    : `<div class="backup-card">${icon("shield-alert")}<div class="row-main"><strong>No hub backup recorded</strong><p>Enable backup in a linked device’s Settings.</p></div></div>`;
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
    "This device",
    `<div class="settings-card">${setting("Device name", "Shown to other devices and in history.", `<input id="machine-name" aria-label="Device name" maxlength="100" value="${escape(status.name)}">`)}${setting("Default folder location", `<span class="path">${escape(status.root)}</span>`, button("Copy path", "copy", status.root, "secondary small-button", "copy"))}</div>`,
  );
  html += section(
    status.role === "hub" ? "Hub synchronization" : "Local synchronization",
    `<div class="settings-card">${setting(status.role !== "hub" && !status.hub ? "Disconnected" : status.phase === "paused" ? "Paused" : "Enabled", status.role === "hub" ? "Synchronizes this hub’s working folders with connected devices." : "Synchronizes the folders selected on this device.", "")}</div>`,
  );
  if (status.role === "hub")
    html += section(
      "Access to this hub",
      `<div class="settings-card">${setting("Authorized devices", "Issue pairing codes and remove devices from this hub.", button("Manage devices", "machines", "", "secondary small-button", "monitor-smartphone"))}</div>`,
    );
  if (!native)
    html += section(
      "Browser session",
      `<div class="settings-card">${setting("This browser", `Signed in to ${escape(status.name)}. Signing out does not stop synchronization.`, button("Sign out", "logout", "", "secondary small-button", "log-out"))}${setting("Other browser sessions", `Sign out every browser managing ${escape(status.name)}. Device connections are kept.`, button("Sign out all browsers…", "logout-all", "", "secondary small-button danger", "log-out"))}</div>`,
    );
  if (native)
    html += section(
      "Desktop preferences",
      `<div class="settings-card">${status.platform === "darwin" ? setting("Launch at login", "Start synchronization when you sign in to this Mac.", '<div id="service-control"><span class="hint">Checking service…</span></div>') : ""}${setting("System notifications", "Show system notifications for conflicts, hub errors and stopped backups.", toggleControl("notifications-enabled", "Enable system notifications"))}</div>`,
    );
  html += section(
    status.role === "hub" ? "Hub backup" : "Full backup on this device",
    status.role === "hub"
      ? backupSummary()
      : !status.hub
        ? '<div class="panel"><p>Connect to a hub first.</p></div>'
        : `<div class="settings-card">${setting(`Keep a full backup of the hub here`, "Every shared folder and its retained history, in a dedicated folder outside your synced folders. Your own folders keep syncing. This copy never publishes edits.", toggleControl("backup-enabled", "Enable hub backup", status.backup?.enabled, "data-backup-toggle"))}${setting("Backup location", `<span class="path">${escape(status.backup?.path || "Not configured")}</span>`, status.backup?.path ? button("Copy path", "copy", status.backup.path, "secondary small-button", "copy") : button("Choose…", "enable-backup", "", "secondary small-button", "folder-input"))}${backupCompletionSetting()}</div>`,
  );
  if (status.role === "hub")
    html += section(
      "History",
      `<div class="settings-card">${setting("Older versions", `${Number(status.historyRevisions || 0).toLocaleString("en")} kept across your folders. Each folder decides how long it keeps them.`, button("Clean up…", "retention", "", "secondary small-button", "trash-2"))}</div><p class="hint">Cleanup shows what it would remove before anything is deleted. Current files, pending changes and history not yet backed up are never removed.</p>`,
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
      `<div class="settings-card">${setting("Allow HTTP connections", "Pair and sync over your local network without Tailscale. Anyone on that network could read your files and sign-in details, so use it only on a network you trust.", toggleControl("allow-lan-http", "Allow HTTP on local network", network?.allowLanHttp === true, network ? "" : "disabled"))}</div>`,
    );
  html += section(
    "Device discovery",
    `<div class="settings-card">${setting("Find devices on Tailscale", "Look for Arca on connected devices. Finding a device does not link it.", button("Refresh", "network-refresh", "", "secondary small-button", "refresh-cw"))}</div>`,
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
    `<div class="settings-card replica-danger">${setting(destroyRole === "hub" ? "Erase this hub" : "Erase this device", destroyRole === "hub" ? "Deletes this hub’s shared folders, files, version history and configuration, then returns to setup. Other devices keep their own copies." : "Deletes all local folders and resets Arca on this device. Hub files and other devices are kept.", button(destroyRole === "hub" ? "Erase this hub…" : "Erase this device…", `destroy-${destroyRole}`, "", "primary danger", "trash-2"))}</div>`,
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
      const target = root.querySelector("#image-regenerate-job");
      target.hidden = !job;
      const hint = root.querySelector("#image-regenerate-hint");
      hint.classList.toggle("image-hint-replaced", !!job);
      hint.setAttribute("aria-hidden", String(!!job));
      const running = job?.state === "running";
      const control = root.querySelector("#image-regenerate-control");
      const markup = running
        ? button(
            "Stop process",
            "images-cancel",
            "",
            "secondary small-button",
            "square",
          )
        : button(
            "Regenerate previews",
            "images-regenerate",
            "",
            "secondary small-button",
            "refresh-cw",
          );
      if (control.dataset.markup !== markup) {
        control.innerHTML = markup;
        control.dataset.markup = markup;
      }
      if (job) {
        const label = "Refreshing previews";
        const state =
          {
            complete: "Completed",
            cancelled: "Stopped",
            failed: "Could not finish. Try again.",
          }[job.state] || label;
        const summary = `${state} · ${job.done} / ${job.total} processed`;
        target.innerHTML = `<p class="hint" title="${escape(summary)}">${escape(summary)}</p>
          <progress aria-label="${escape(label)}" value="${Number(job.done) || 0}" max="${Math.max(1, Number(job.total) || 0)}"></progress>`;
      } else target.innerHTML = "";
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
    ![
      ...$("#dialog-content").querySelectorAll(
        "input, select, textarea, table, .folder-selection",
      ),
    ].some((field) => !field.closest(".confirmation-option"))
  )
    $("#dialog").classList.add("confirmation-dialog");
  $("#cancel-dialog").autofocus = Boolean(
    $("#dialog-content").querySelector(".confirmation-option"),
  );
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
function bindDialog(dialog) {
  const cancel = dialog.querySelector("#cancel-dialog");
  const form = dialog.querySelector("#dialog-form");
  const control = dialog.querySelector("#submit-dialog");
  let pending = null;
  const idle = () => {
    control.removeAttribute("aria-busy");
    control.querySelector(".busy-grid")?.remove();
    control.disabled = false;
  };
  const close = () => {
    dialog.close();
    dialog.restore?.();
  };
  const dismiss = () => {
    if (pending) {
      pending.detached = true;
      pending = null;
      idle();
    }
    close();
  };
  cancel.onclick = dismiss;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  // Dialogs close explicitly; backdrop interaction never discards a draft.
  form.onsubmit = (event) => {
    event.preventDefault();
    if (pending) return;
    const submit = submitDialog;
    const data = new FormData(event.target);
    const submission = { detached: false };
    pending = submission;
    control.disabled = true;
    action(async () => {
      if (submission.detached) return;
      control.setAttribute("aria-busy", "true");
      control.insertAdjacentHTML("afterbegin", busyIcon());
      try {
        dialog.querySelector("#dialog-error").hidden = true;
        let complete;
        try {
          complete = await submit(data);
        } catch (error) {
          if (!submission.detached || (!native && error?.status === 401))
            throw error;
          if (daemonUnavailable(error)) showDaemonStopped();
          else notice(error?.message || String(error), true, { id: "action" });
          return;
        }
        if (submission.detached) {
          if (complete === undefined && ready)
            void background(() => render({ refreshStatus: true }));
          return;
        }
        if (complete === false) return;
        close();
        if (typeof complete === "function") await complete();
        else if (ready) void background(() => render({ refreshStatus: true }));
      } finally {
        if (pending === submission) {
          pending = null;
          idle();
        }
      }
    });
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
    row.textContent = "Checking path…";
    try {
      const result = await api("/v1/path-check", { path: input.value, id });
      if (serial !== sequence || !row.isConnected) return;
      row.classList.remove("path-check-error");
      const needed = selection && catalog.find((v) => v.id === id)?.bytes;
      const capacity = `${Number.isFinite(needed) ? `Needs ${bytes(needed)} · ` : ""}${bytes(result.freeBytes)} free`;
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
      "Detection does not link a device. Enter the code issued by the hub administrator.",
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
    : '<p class="hint">Use this hub’s reachable hostname or IP with its API port. A localhost address only works on this device.</p>';
  let invitation;
  const create = async () => {
    invitation = await api("/v1/pairing", {
      name: name || "New device",
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
      "Pair a device",
      "On the new device, open Arca and choose Pair with your hub. A computer picks Another device first; one already set up uses Connect to hub. Enter the address and pairing code below.",
      "key-round",
    ) +
      addressPanel +
      `<p class="hint">Include the full address, with http:// or https:// and its port. A hostname works when the new device can resolve it; otherwise use the IP address. For HTTP, use Tailscale on both devices or enable local network HTTP in the hub’s Settings and use its private IPv4 address.</p><div class="section-label">Pairing code</div><div class="code-display" id="pair-code">··· — ···</div><div class="code-toolbar"><p class="code-expiry" id="pair-validity">Generating code…</p><div class="form-actions">${button("Copy code", "copy-pair", "", "secondary small-button", "copy")}${button("New code", "new-pair", "", "secondary small-button", "refresh-cw")}</div></div><p>After connecting, choose the folders to sync and their local destinations.</p><div class="callout">${icon("info")}<p>Issuing a code does not mean a device has connected. This code never grants web administration.</p></div>`,
    async () => {},
    "Done",
  );
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
  if (id === status.id || (status.deviceId && id === status.deviceId)) return status.name;
  if (id === status.hubId) return hubName();
  return (
    status.devices.find((d) => d.id === id)?.name ||
    status.hubDevices?.find((d) => d.id === id)?.name ||
    `Device ${String(id).slice(0, 8)}`
  );
}
async function reviewConflict(item) {
  if (
    status.role !== "hub" &&
    !status.volumes.find((v) => v.id === item.volume)?.selected
  )
    throw new Error(
      "Start syncing this folder before resolving conflicts.",
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
      "triangle-alert",
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
            ? [
                [original, originalData],
                [conflict, conflictData],
              ]
                .filter(([v]) => !v.deleted)
                .map(([v, data]) => {
                  const href =
                    status.role === "hub"
                      ? `/v1/blobs/${v.hash}`
                      : data.local?.hash === v.hash
                        ? `/v1/gallery/download?${new URLSearchParams({ volume: item.volume, path: v.path, hash: v.hash })}`
                        : null;
                  return href
                    ? `<a class="secondary" href="${escape(href)}" download="${escape(v.path.split("/").at(-1))}">${icon("download")}Download ${v === original ? "original" : "conflict copy"}</a>`
                    : "";
                })
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
    "Restore selected as new version",
    true,
  );
  $("#dialog").classList.add("conflict-dialog");
  const extra = $("#dialog-content .form-actions");
  extra.id = "dialog-extra-actions";
  $("#dialog-form > .dialog-actions").prepend(extra);
  $("#cancel-dialog").hidden = false;
  $("#submit-dialog").innerHTML =
    icon("undo-2") + "Restore selected as new version";
  icons();
}
async function handle(name, id, control) {
  if (name.startsWith("music-")) return handleMusic(name, id);
  if (name === "install-update") {
    const button = $("#update-install");
    button.disabled = true;
    button.textContent = "Installing…";
    try {
      await invoke("install_update");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Update and restart";
      throw error;
    }
    return;
  }
  if (name === "pick-device") return pickDevice(id);
  if (name === "web-approver") {
    const enabled = !status.webApprovers?.includes(id);
    modal(
      modalHeader(
        enabled ? "Allow web approval?" : "Disable web approval?",
        enabled
          ? "This device will be able to approve administrator access to this hub’s web interface."
          : "This device will no longer approve web access.",
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
        "Updates the name on every device. Folder locations stay the same.",
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
        '<label for="ignore-rules">Exclusion rules</label><textarea id="ignore-rules" class="ignore-editor mono" name="text" spellcheck="false" aria-describedby="ignore-hint"></textarea><p id="ignore-hint" class="hint">One gitignore pattern per line, added to the exclusions Arca always applies. Saving creates the file if it is missing.</p>',
      async (f) => {
        await api("/v1/ignore-policy", {
          id,
          text: f.get("text"),
          version: policy.version,
        });
        notice(
          "Exclusion rules saved. They will propagate when devices sync.",
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
  if (name === "enable-music") {
    modal(
      modalHeader(
        "Enable music library?",
        "Browse and play this folder’s music by artist and album here, on your phone and in the car. Files and synchronization stay the same.",
        "music",
      ),
      async () => {
        await api("/v1/music/mark", { volume: id });
        folderTab = "library";
      },
      "Enable music library",
    );
    return;
  }
  if (name === "gallery-zoom") {
    if (galleryZoom === id || !galleryView) return;
    galleryZoom = id;
    galleryView.setZoom();
    return;
  }
  if (name === "gallery-mode") {
    const volume = status.volumes.find((v) => v.id === detailId);
    if (!volume?.gallery) return;
    const exiting = folderTab === "gallery";
    if (exiting) {
      galleryReturn = galleryView && {
        volume: detailId,
        items: galleryView.items,
        next: galleryView.next,
        previous: galleryView.previous,
        range: galleryView.range,
        dates: galleryView.dates,
        undated: galleryView.undated,
        month: galleryView.month,
        days: galleryView.days,
        scroll: $(".page")?.scrollTop || 0,
      };
      folderTab = folderReturn.tab;
    } else {
      folderReturn = { tab: folderTab, scroll: $(".page")?.scrollTop || 0 };
      folderTab = "gallery";
    }
    await render();
    if (exiting && folderTab !== "gallery" && $(".page"))
      $(".page").scrollTop = folderReturn.scroll;
    return;
  }
  if (
    name === "folder-tab" ||
    name === "browse-directory" ||
    name === "browse-more" ||
    name === "browse-retry" ||
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
    const keepScroll = name === "browse-more" || name === "browse-retry";
    const scroll = keepScroll ? $(".page")?.scrollTop || 0 : 0;
    if (name === "browse-more") {
      if (folderPageCount === Number(id)) folderPageCount += 1;
    } else if (name !== "browse-retry") folderPageCount = 1;
    await render();
    if (keepScroll && $(".page")) $(".page").scrollTop = scroll;
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
      folderPageCount = 1;
    }
    detailId = id;
    const from = [...document.querySelectorAll(".folder-card[data-id]")]
      .find((card) => card.dataset.id === id)
      ?.querySelector(".home-lead, .tile")
      ?.getBoundingClientRect();
    await render();
    flip(document.querySelector(".detail-title .tile"), from);
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
  if (name === "history-day") {
    await jumpToDay(id);
    return;
  }
  if (name === "history-away-show") {
    showAway();
    return;
  }
  if (name === "history-away-dismiss") {
    awayNotice = null;
    document.querySelector("#history-list .act-away")?.remove();
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
      rev: currentFileRev(),
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
      rev: currentFileRev(),
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
    $("#submit-dialog").classList.add("danger");
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
    fileRevision = Number.isSafeInteger(item.rev)
      ? { volume: item.volume, path: item.path, rev: item.rev }
      : null;
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
        `This creates a new version with the contents of rev ${id}. Existing versions stay in history.`,
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
      "Restore as new version",
    );
    $("#submit-dialog").innerHTML = icon("undo-2") + "Restore as new version";
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
        "Every browser managing this Arca service will need a new access code. Device synchronization credentials stay linked.",
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
    $("#submit-dialog").classList.add("danger");
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
        destroyingHub ? "Erase this hub and all its folders?" : "Erase this device?",
        destroyingHub
          ? "Permanently deletes this hub’s shared folders, files, version history and configuration. Other devices keep their local files and lose access to this hub. Arca returns to setup, where you can set up a hub or connect to one."
          : "Permanently deletes local folders, including unsynced changes, and resets Arca on this device. Hub files, hub history and other devices are kept.",
        "trash-2",
      ) +
        `<ul>${paths.map((p) => `<li class="path">${escape(p)}</li>`).join("")}</ul><p class="hint">This cannot be undone. ${destroyingHub ? "No deletions are sent to other devices." : "Works offline. If the hub cannot be reached, remove this device from its Devices list separately."} An interrupted cleanup can be retried.</p>`,
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
            `${destroyingHub ? "Hub" : "Device"} erased. Generate a new local web access code to begin setup.`,
          );
      },
      destroyingHub ? "Erase this hub" : "Erase this device",
      true,
    );
    $("#submit-dialog").classList.add("danger");
    return;
  }
  if (name === "disconnect-hub" && status.role === "replica") {
    modal(
      modalHeader(
        `Disconnect from hub?`,
        "Stops synchronization and any full backup on this device. Local files, saved destinations and hub history are kept. Reconnecting requires a new pairing code.",
        "unplug",
      ) +
        '<p class="hint">Disconnects this device on both sides. The hub must be reachable to complete this action.</p>',
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
  if (name === "palette") return openPalette();
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
        `Remove ${escape(d?.name || "this device")}?`,
        "Removes this device’s access and connection reports from the hub. The device updates when it next contacts the hub. Files and version history are kept. Connecting again requires a new pairing code.",
        "unplug",
      ),
      async () => {
        await api("/v1/revoke", { id });
        notice("Device removed.");
      },
      "Remove device",
    );
    $("#submit-dialog").classList.add("danger");
    return;
  }
  if (name === "delete-share" && status.role === "hub") {
    const v = status.volumes.find((v) => v.id === id);
    modal(
      modalHeader(
        `Delete “${escape(v.name)}”?`,
        "Permanently removes this shared folder’s catalog and history from the hub. Connected devices stop syncing when they refresh. Files on disk and existing backups are kept.",
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
    const deleteLabel = `Delete the files on ${machineLabel()}`;
    modal(
      status.role === "hub"
        ? modalHeader(
            "Stop syncing on this hub?",
            "Stops this hub’s local copy. The shared folder and history remain available.",
            "unlink",
          )
        : modalHeader(
            `Stop syncing “${escape(folder.name)}”?`,
            `Stops syncing it on ${machineLabel()}. The hub keeps the shared folder, its files and history.`,
            "unlink",
          ) +
            `<div class="confirmation-option">${toggleControl("unlink-delete", deleteLabel, true, 'name="deleteFiles"')}<label for="unlink-delete">${deleteLabel}</label></div>`,
      async (f) => {
        const deleteFiles = f.get("deleteFiles") === "on";
        const result = await api(
          "/v1/unselect",
          deleteFiles ? { id, deleteFiles } : { id },
        );
        detailId = null;
        notice(
          status.role === "hub"
            ? "Stopped syncing on this hub. The shared folder remains available."
            : deleteFiles
              ? `Stopped syncing. ${countLabel(result.deleted, "file")} (${bytes(result.deletedBytes)}) deleted from ${machineLabel()}${result.kept ? `; ${countLabel(result.kept, "file")} not on the hub stay on disk` : ""}.`
              : "Stopped syncing. Your files remain on disk.",
        );
      },
      status.role === "hub" ? "Stop syncing here" : "Stop syncing",
    );
    $("#submit-dialog").classList.add("danger");
    const option = $('#dialog [name="deleteFiles"]');
    if (option) {
      option.onchange = () => {
        $("#submit-dialog").textContent = option.checked
          ? "Stop syncing and delete"
          : "Stop syncing";
      };
      option.onchange();
    }
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
        "Only the hub creates shared folders. Devices then start syncing it and choose their own destination.",
        "folder-plus",
      ) +
        textField("Name", "name") +
        '<p class="hint">Shown to every device. Portable name: no slashes, no reserved words, no case collisions.</p>' +
        pathInput(
          `Path on ${escape(status.name)}`,
          "path",
          status.root.replace(/\/$/, "") + "/",
          "server",
        ) +
        '<p class="hint">Use an existing folder or create a new one. It must be accessible to Arca and outside other shared folders and the state directory.</p>',
      async (f) => {
        await api("/v1/volumes", {
          name: f.get("name"),
          path: f.get("path"),
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
          "Keep complete copies on this device.",
          "folder",
        ),
        async () => {},
        "Done",
      );
      $("#dialog-content").insertAdjacentHTML(
        "beforeend",
        '<div class="empty">' +
          icon("folder-check") +
          "<h3>All folders are syncing here</h3><p>New shared folders will appear here when the hub creates them.</p></div>",
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
          "Choose a shared folder to start syncing on this device.",
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
        `<div class="callout">${icon("info")}<p>Files excluded by .arcaignore stay local. Other changes, including deletions, sync between devices.</p></div></div>`,
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
        "Keep every shared folder and retained version in a separate location while working-folder sync continues.",
        "shield-check",
      ) +
        pathInput("Backup location", "path", status.backup?.path || "") +
        '<p class="hint">Use an empty dedicated folder outside synchronized folders and Arca’s state; in Docker, a mounted folder. Disabling backup keeps its data.</p>',
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
  if (name === "images-regenerate") {
    await api("/v1/images", { action: "regenerate" });
    return imageLibrary();
  }
  if (name === "retention") {
    let preview = null;
    const recount = () => {
      if (!preview) return;
      preview = null;
      $("#retention-preview").innerHTML = "";
      $("#submit-dialog").textContent = "See the count";
      $("#submit-dialog").classList.remove("danger");
    };
    modal(
      modalHeader(
        "Clean up older versions",
        "Nothing is removed until you apply. See the count first.",
        "trash-2",
      ) +
        `<label for="retention-days">Remove versions older than (days)</label><input id="retention-days" name="days" type="number" min="0" value="${status.retention.days || 0}" required><label for="retention-versions">But always keep the last (versions per file)</label><input id="retention-versions" name="versions" type="number" min="0" value="${status.retention.versions || 0}" required><p class="hint">Leave a field at 0 to skip that rule.</p><div id="retention-preview" role="status"></div>`,
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
          const counted = { ...values, ...(await api("/v1/retention", values)) };
          const field = (name) =>
            document.querySelector(`#dialog-form [name="${name}"]`)?.value;
          if (
            Number(field("days")) !== values.days ||
            Number(field("versions")) !== values.versions
          )
            return false;
          preview = counted;
          const count = (n) => Number(n).toLocaleString("en");
          $("#retention-preview").innerHTML =
            `<div class="retention-stats"><div class="panel"><span class="hint">Would remove</span><strong>${count(preview.remove)}</strong></div><div class="panel"><span class="hint">Keeps</span><strong>${count(preview.retained)}</strong></div><div class="panel"><span class="hint">Protected</span><strong>${count(preview.protected)}</strong><p>current · pending · unbacked</p></div></div><div class="settings-card">${(preview.folders || []).map((v) => setting(escape(v.name), `${count(v.remove)} versions would be removed`, `${count(v.retained)} kept`)).join("")}</div><div class="callout warning">${icon("triangle-alert")}<p>Cleanup cannot be undone on this hub. Kept counts are older versions only and include protected ones. No cleanup is scheduled.</p></div>`;
          $("#submit-dialog").innerHTML = icon("trash-2") + "Apply cleanup";
          icons();
          $("#submit-dialog").classList.add("danger");
          return false;
        }
        try {
          await api("/v1/retention", {
            ...values,
            apply: true,
            confirmation: preview.confirmation,
          });
        } catch (error) {
          recount();
          throw error;
        }
        notice("Cleanup applied.");
      },
      "See the count",
    );
    for (const field of document.querySelectorAll(
      '#dialog-form [name="days"], #dialog-form [name="versions"]',
    ))
      field.addEventListener("input", recount);
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
        `${!plan.catalog.length ? '<div class="callout warning">' + icon("triangle-alert") + "<p>No shared folders are available for recovery on this device.</p></div>" : ""}<div class="settings-card">${plan.catalog
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
          )}${setting("Full hub backup", plan.backupEnabled ? "Turn off full backup in Settings before replacing the hub." : "Off on this device.", pill(plan.backupEnabled ? "Enabled" : "Off", plan.backupEnabled ? "wa" : "id", "shield"))}</div><p>${escape(plan.warning || "Unseen changes and old history cannot be reconstructed from working copies.")}</p><label class="inline-check"><input name="confirmed" type="checkbox" required>I confirm the old hub is stopped and will not return as the active hub.</label>`,
      async (f) => {
        await api("/v1/promote", { confirmed: f.has("confirmed") });
      },
      "Make this device the hub",
    );
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
  "enable-music",
  "delete-share",
  "rename-share",
  "rename-file",
  "delete-file",
  "connect",
  "replacement-hub",
  "refresh",
  "gallery-mode",
  "music-mode",
  "music-tab",
  "music-artist",
  "music-album",
  "music-playlist",
  "music-add",
  "music-pick",
  "music-pick-new",
  "music-remove",
  "music-playlist-rename",
  "music-playlist-delete",
  "music-back",
  "music-more",
  "music-retry",
  "music-track",
  "music-play",
  "music-shuffle",
  "music-song",
  "music-shuffle-all",
  "music-shuffle-artist",
  "music-search-toggle",
  "music-search-apply",
  "music-search-more",
  "folder-tab",
  "browse-directory",
  "browse-more",
  "browse-retry",
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
  if (hubOnlyActions.has(name) && hubOffline())
    return Promise.resolve(hubOnlyBlocked());
  const work = () => handle(name, id, control);
  return navigationActions.has(name) ? navigate(work) : action(work, control);
}
document.addEventListener("click", (e) => {
  document.querySelectorAll(".file-actions-menu[open], .folder-actions-menu[open]").forEach((menu) => {
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
      else if (daemonUnavailable(error)) showDaemonStopped();
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
    if (!ready || data.offline) return;
    const requests = data.requests.filter((r) => !(r.expires <= Date.now()));
    if (approvalModal && !requests.some((r) => r.id === approvalModal)) {
      if ($("#dialog").dataset.approval === approvalModal) $("#dialog").close();
      approvalModal = null;
    }
    if (busy || $("#dialog").open || !requests.length) return;
    const r = requests[0];
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
  recentSaved.clear();
  recentFailed.clear();
  stopMusic();
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
        { label: "Approve on a device", action: "login-approval" },
      ],
      "access-tabs",
    )}</div>
    <div id="access-code"><form id="web-login"><label>Web access code</label>${codeFields("web")}<p class="hint">${icon("clock")} Single use · valid ten minutes from generation</p><p id="login-error" role="alert">${escape(message)}</p><button class="primary" type="submit">${icon("log-in")}Open Arca</button></form><div class="access-help"><h3>Get a code</h3><p>On the server, run <code>docker exec &lt;container&gt; node packages/cli/arca.js web-code</code> if Arca runs in Docker, or <code>arca web-code</code> if it is installed directly.</p><p>The command prints a result that includes a six-digit code. Enter that code above.</p></div></div>
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
          "Approve only if the device shows this same number.",
        ) +
        `<p class="approval-instructions">Open Arca on an authorized device or your phone.</p><p class="approval-countdown">${busyIcon()}<span id="request-countdown"></span></p><button type="button" class="secondary">Cancel request</button>`;
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
  stopMusic();
  document.body.classList.remove("access-mode");
  document.body.classList.add("onboarding-mode");
  const o = onboarding;
  const activeStep = { 0: 0, access: 0, 2: 1, 3: 2 }[o.step] ?? o.step;
  const steps = ["This device", "Connect", "Folders"];
  const connectSkipped = o.role === "hub" && o.step !== 0 && o.step !== -1;
  const webCodeCommand =
    "docker exec <container> node packages/cli/arca.js web-code";
  let body = "";
  if (o.step === -1)
    body = `<p>Your personal drive, on your own devices.</p><h1>Many devices.<br><em class="accent-text">One space.</em></h1><p>Arca keeps the folders you choose in sync across your laptop, tablet and phone, with complete local copies and a hub you run yourself.</p>${[
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
        "Your storage, your devices. No cloud account, no telemetry.",
      ],
    ]
      .map(
        ([symbol, heading, description]) =>
          `<div class="settings-card">${setting(heading, description, "", icon(symbol))}</div>`,
      )
      .join("")}`;
  if (o.step === 0)
    body = `<h1>Set up this device</h1><p>Shown to other devices and in history.</p>${textField("Device name", "name", o.name, "monitor")}${o.platform ? `<p class="hint">${escape(platformLabel(o.platform))}${o.arch ? ` · ${escape(o.arch)}` : ""}</p>` : ""}${[
      [
        "hub",
        "server",
        "The hub",
        "Keeps the folders and their history. Choose this for the device that stays on: a server, a NAS or a computer that is rarely off.",
      ],
      [
        "replica",
        "monitor-smartphone",
        "Another device",
        "Keeps the folders you choose. Needs a pairing code from your hub.",
      ],
    ]
      .map(
        ([value, symbol, name, desc]) =>
          `<label class="role-card"><input name="role" type="radio" value="${value}" ${o.role === value ? "checked" : ""}>${icon(symbol)}<div><strong>${name}</strong><p>${desc}</p></div></label>`,
      )
      .join("")}`;
  if (o.step === "access")
    body = `<h1>Confirm server access</h1><p>Enter a web access code to save this server's configuration.</p>${o.setupCodePath ? '<p><a href="/umbrel" target="_blank" rel="noopener">Get a code from Umbrel</a>, then return here.</p>' : `<p>On the server, run:</p><div class="settings-card">${setting("Command", `<span class="mono">${escape(webCodeCommand)}</span>`, button("Copy", "copy", webCodeCommand, "secondary small-button", "copy"))}</div><p class="hint">The command prints a result that includes a six-digit code. Enter that code below.</p>`}<label>Web access code</label>${codeFields("setup-access")}<p class="hint">Single use · valid ten minutes. This is not a hub pairing code.</p>`;
  if (o.step === 2 && !o.paired)
    body = `<h1>Pair with your hub</h1><p>Connect with a single-use code from your hub.</p>${textField("Hub address", "url", o.url, "server", "https://arca.your-network", "mono")}<label>Pairing code</label>${codeFields("onboarding")}<p class="hint">${icon("clock")}Single use · valid ten minutes.</p>`;
  if (o.step === 2 && o.paired)
    body = `<h1>Finish setup</h1><p>Paired with ${escape(o.hubName || "your hub")}. Your connection is saved.</p><p>No folders have been downloaded. Choose them after setup.</p>`;
  if (o.step === 3)
    body = `<h1>A home for your folders</h1><p>${o.role === "replica" ? "Folders you select from the hub live here, as ordinary folders." : "Choose a default location for the folders you share."}</p><div class="root-selection"><div class="tile large">${icon("folder")}</div><div class="row-main"><strong>Folder root</strong><input aria-label="Folder root" class="mono" name="root" value="${escape(o.root)}" required></div>${native ? button("Change…", "pick-path", "root", "secondary small-button", "folder-input") : ""}</div><div id="setup-space"></div><p class="hint">Must be empty or new. Nothing is downloaded until you select folders.</p>${native ? "" : '<p class="hint">This path is on the server. In Docker or Umbrel, use persistent mounted storage; the default is /data/files.</p>'}`;
  $("#content").innerHTML =
    `<div class="onboarding"><div class="onboarding-rail"><div class="brand"><img src="assets/arca-icon.svg" width="28" height="28" alt="Arca"><b>arca</b></div><div class="steps">${steps.map((label, i) => `<div class="step ${activeStep === i ? "current" : activeStep > i && !(connectSkipped && i === 1) ? "done" : ""}" ${activeStep === i ? 'aria-current="step"' : ""}><span>${activeStep > i && !(connectSkipped && i === 1) ? icon("check") : i + 1}</span>${label}${i === 1 && connectSkipped ? " · Not needed" : ""}</div>`).join("")}</div></div><form id="setup-form" class="onboarding-body">${body}<p id="setup-error" class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" id="setup-back" class="ghost" ${o.step < 0 || o.initialized ? "disabled" : ""}>${icon("chevron-left")}Back</button><button type="submit" class="primary">${o.step < 0 ? "Get started" : o.step === 3 ? "Finish" : "Continue"}${icon("chevron-right")}</button></div></form></div>`;
  $("#setup-back").onclick = () => {
    o.step =
      o.step === "access" || o.step === 2 || (o.step === 3 && o.role === "hub")
        ? 0
        : o.step === 3
          ? 2
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
        if (!current) throw new Error("Arca is still starting. Try again.");
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
  } else if (state.stopped) showDaemonStopped(state.error);
  else await refresh();
}
function daemonUnavailable(error) {
  return (
    native &&
    (error?.message || String(error)) ===
      "The daemon is unavailable. Use Start service."
  );
}
function showDaemonStopped(error) {
  ready = false;
  daemonStopped = { error: error ?? daemonStopped?.error ?? "" };
  updateBrandActivity();
  if (status) updateShell();
  renderDaemonStopped();
  if (daemonProbe) return;
  let probing = false;
  daemonProbe = setInterval(async () => {
    if (probing) return;
    probing = true;
    await refresh().catch(() => {});
    probing = false;
  }, 5000);
}
function renderDaemonStopped() {
  $("#content").innerHTML =
    title("Service stopped") +
    `<div class="page">${empty("Your files remain on disk", daemonStopped.error ? escape(daemonStopped.error) : "Start the Arca service to check your folders.", button("Start service", "start", "", "primary", "power"))}</div>`;
  icons();
}
function daemonRecovered() {
  daemonStopped = false;
  clearInterval(daemonProbe);
  daemonProbe = null;
  noticeStore.clear("action");
  noticeStore.reconcile([], "view:");
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
    if (daemonUnavailable(error)) showDaemonStopped();
    else if (error.transportError && error.readOnly)
      notice(error.message, true, { id: "connection", action: "refresh" });
    else if (!busy && !$("#dialog").open)
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
  $("#update-heading").textContent = `Arca ${update.version} is available`;
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

  window.__TAURI__.event.listen("music-command", (event) => {
    const command = event.payload?.command;
    if (command === "state") return musicBroadcast(true);
    if (!musicPlayer) return;
    if (command === "toggle") musicPlayPause();
    if (command === "next") musicStep(1);
    if (command === "previous") musicPrevious();
    if (command === "show") void navigate(musicShowAlbum);
  });
  musicBroadcast(true);
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
    if (event.key === " " && event.target.dataset.action === "activity-file") {
      if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) openQuickLook(event.target);
    }
    else event.target.click();
    return;
  }
  if (event.target.id === "music-search-input" && ["Enter", "Escape"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "Enter") return void musicSearchInput(event.target.value);
    document.querySelector('[data-action="music-search-toggle"]')?.click();
    return;
  }
  if (event.target.id === "folder-search-input" && event.key === "Enter") {
    event.preventDefault();
    document.querySelector('[data-action="folder-search-apply"]')?.click();
  }
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    view === "devices" &&
    pickedDevice &&
    !document.querySelector("dialog[open]")
  )
    pickDevice(pickedDevice);
});
// File actions use a native disclosure, with keyboard dismissal and focus return.
document.addEventListener("keydown", (event) => {
  const menu = event.target.closest(".file-actions-menu[open], .folder-actions-menu[open]");
  if (menu && event.key === "Escape") {
    event.preventDefault();
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});
document.addEventListener("focusin", (event) => {
  document.querySelectorAll(".file-actions-menu[open], .folder-actions-menu[open]").forEach((menu) => {
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
      const ids = (trigger.getAttribute("aria-describedby") || "")
        .split(" ")
        .filter((id) => id && id !== tip.id);
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
      target.setAttribute(
        "aria-describedby",
        [target.getAttribute("aria-describedby"), tip.id]
          .filter(Boolean)
          .join(" "),
      );
      const rect = target.getBoundingClientRect();
      const bounds = tip.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(
          rect.right - bounds.width,
          window.innerWidth - bounds.width - 8,
        ),
      );
      const top =
        rect.top >= bounds.height + 14
          ? rect.top - bounds.height - 6
          : rect.bottom + 6;
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
    }, 200);
  };
  document.addEventListener("pointerover", (event) =>
    open(event.target.closest("[data-tooltip]")),
  );
  document.addEventListener("pointerout", (event) => {
    if (trigger && !trigger.contains(event.relatedTarget)) close();
  });
  document.addEventListener("focusin", (event) =>
    open(event.target.closest("[data-tooltip]")),
  );
  document.addEventListener("focusout", close);
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  document.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  new MutationObserver(() => {
    if (trigger && !trigger.isConnected) close();
  }).observe(document.body, { childList: true, subtree: true });
}
installTooltips();
