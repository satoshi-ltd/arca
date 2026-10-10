import { fail } from "./storage.js";

export const FAVORITE_KINDS = ["folder", "path", "artist", "album", "playlist", "show"];
const MAX_FAVORITES = 500;

const key = (item) => JSON.stringify([item.folder, item.kind, item.target]);

function pathGone(store, source, item) {
  const live = store.db.prepare(`SELECT 1 FROM ${source} WHERE volume=? AND deleted=0 LIMIT 1`).get(item.folder);
  if (!live) return false;
  return !store.db
    .prepare(`SELECT 1 FROM ${source} WHERE volume=? AND deleted=0 AND (path=? OR (path>? AND path<?)) LIMIT 1`)
    .get(item.folder, item.target, `${item.target}/`, `${item.target}0`);
}

function reconcile(store, items) {
  const selected = store.volumes().filter((v) => v.selected);
  const ids = new Set(selected.map((v) => v.id));
  const indexed = new Set(selected.filter((v) => store.config.role === "hub" || v.last_sync).map((v) => v.id));
  const source = store.fileSource();
  const kept = items.filter((item) => ids.has(item.folder) && !(item.kind === "path" && indexed.has(item.folder) && pathGone(store, source, item)));
  return {
    items: kept.map((item) => (item.kind === "folder" ? { ...item, label: selected.find((v) => v.id === item.folder).name } : item)),
  };
}

function persist(store, config, state) {
  const before = JSON.stringify(config.favorites ?? null);
  if (before === JSON.stringify(state)) return;
  const previous = config.favorites;
  config.favorites = state;
  try {
    store.saveConfig();
  } catch (error) {
    config.favorites = previous;
    throw error;
  }
}

export function listFavorites(store, config) {
  const state = reconcile(store, config.favorites?.items ?? []);
  persist(store, config, state);
  return { favorites: state.items };
}

function clean(item) {
  if (!item || typeof item !== "object") fail("Invalid favorite");
  const { folder, kind, target = "", label = "" } = item;
  if (typeof folder !== "string" || !FAVORITE_KINDS.includes(kind) || typeof target !== "string" || typeof label !== "string")
    fail("Invalid favorite");
  if (target.length > 4096 || label.length > 256) fail("Invalid favorite");
  if (kind === "folder" && target) fail("Invalid favorite");
  if (kind !== "folder" && !target) fail("Invalid favorite");
  const normal = target.normalize("NFC");
  if (kind === "path" && (normal.startsWith("/") || normal.includes("\\") || normal.split("/").some((part) => !part || part === "." || part === "..")))
    fail("Invalid favorite path");
  return { folder, kind, target: kind === "path" ? normal : target, label };
}

export function saveFavorites(store, config, body) {
  if (!Array.isArray(body?.favorites) || body.favorites.length > MAX_FAVORITES) fail("Invalid favorites");
  const items = body.favorites.map(clean);
  const seen = new Set();
  for (const item of items) {
    if (seen.has(key(item))) fail("Already in Favorites", 409);
    seen.add(key(item));
    const v = store.volume(item.folder);
    if (!v.selected) fail("Only folders synced on this device can be favorites", 409);
  }
  const state = reconcile(store, items);
  persist(store, config, state);
  return { favorites: state.items };
}
