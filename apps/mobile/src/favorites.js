import { nameOrder } from "./home-data.js";
export const FAVORITE_KINDS = ["folder", "directory", "artist", "album", "playlist", "show"];
export const PHONE_FAVORITES = 5;
export const FAVORITE_LABELS = {
  directory: "Folder",
  artist: "Artist",
  album: "Album",
  playlist: "Playlist",
  show: "Show",
};
export const FAVORITE_ICONS = {
  folder: "folders",
  directory: "folder",
  artist: "artist",
  album: "album",
  playlist: "playlist",
  show: "podcast",
};

export const favoriteKey = (entry) => `${entry.folder}\n${entry.kind}\n${entry.target}`;
export const emptyFavorites = () => ({ items: [] });

const validEntry = (entry) =>
  !!entry &&
  typeof entry.folder === "string" &&
  FAVORITE_KINDS.includes(entry.kind) &&
  typeof entry.target === "string" &&
  typeof entry.label === "string";

export function readFavorites(value) {
  if (!value || !Array.isArray(value.items)) return emptyFavorites();
  const keys = new Set();
  const items = value.items.filter((entry) => {
    if (!validEntry(entry) || keys.has(favoriteKey(entry))) return false;
    keys.add(favoriteKey(entry));
    return true;
  });
  return items.length === value.items.length ? value : { items };
}

export function reconcileFavorites(state, folders) {
  const ids = new Set(folders.map((folder) => folder.id));
  const items = state.items.filter((entry) => ids.has(entry.folder));
  return items.length === state.items.length ? state : { ...state, items };
}

export const isFavorite = (state, entry) =>
  state.items.some((item) => favoriteKey(item) === favoriteKey(entry));

export function toggleFavorite(state, entry) {
  const key = favoriteKey(entry);
  return state.items.some((item) => favoriteKey(item) === key)
    ? { ...state, items: state.items.filter((item) => favoriteKey(item) !== key) }
    : { ...state, items: [...state.items, entry] };
}

export function withoutFavorites(state, keys) {
  const drop = new Set(keys);
  const items = state.items.filter((item) => !drop.has(favoriteKey(item)));
  return items.length === state.items.length ? state : { ...state, items };
}

export const FAVORITE_GROUPS = ["folders", "photos", "audio"];

export function sortFavorites(items, kindOf, labelOf) {
  return items
    .map((entry, index) => ({ entry, index, group: Math.max(0, FAVORITE_GROUPS.indexOf(kindOf(entry))), label: labelOf(entry) }))
    .sort((a, b) => a.group - b.group || nameOrder(a.label, b.label) || a.index - b.index)
    .map((item) => item.entry);
}

export function favoriteCaption(entry, folderName) {
  if (entry.kind === "folder") return "";
  if (entry.kind === "directory")
    return [folderName, ...entry.target.split("/").slice(0, -1)].join(" › ");
  return `${FAVORITE_LABELS[entry.kind]} · ${folderName}`;
}

export function favoriteRoute(entry) {
  if (entry.kind === "folder") return { to: "folder" };
  if (entry.kind === "directory") return { to: "files", directory: `${entry.target}/` };
  const tab = { artist: "artists", album: "albums", playlist: "playlists", show: "podcasts" }[entry.kind];
  return { to: "music", route: [{ kind: tab }, { kind: entry.kind, id: entry.target }] };
}

export const favoritesSettled = (replica) =>
  !!replica &&
  !replica.active &&
  !replica.busy &&
  !replica.moreFolderWork &&
  !replica.hubUnavailable &&
  !replica.holdingOffline;

export async function staleFavorites(items, folders, { hasPath, library }) {
  const missing = [];
  const libraries = new Map();
  for (const entry of items) {
    if (entry.kind === "folder") continue;
    const folder = folders.find((item) => item.id === entry.folder);
    if (!folder?.completed) continue;
    if (entry.kind === "directory") {
      if (!(await hasPath(folder.id, entry.target))) missing.push(favoriteKey(entry));
      continue;
    }
    if (!libraries.has(folder.id)) libraries.set(folder.id, await library(folder.id).catch(() => null));
    const value = libraries.get(folder.id);
    if (value?.saved && !value.indexing && !favoriteExists(entry, value.library)) missing.push(favoriteKey(entry));
  }
  return missing;
}

export function favoriteExists(entry, library) {
  if (entry.kind === "artist") return library.artists.some((artist) => artist.id === entry.target);
  if (entry.kind === "album") return library.albums.has(entry.target);
  if (entry.kind === "playlist") return library.playlists.has(entry.target);
  if (entry.kind === "show") return library.shows.has(entry.target);
  return true;
}
