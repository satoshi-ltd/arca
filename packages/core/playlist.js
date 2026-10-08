export const PLAYLIST_DIRECTORY = "Playlists";
export const PLAYLIST_BYTES = 1024 * 1024;

const directoryOf = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const newline = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const comment = (line) => line.trim().startsWith("#");

export function isPlaylistPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith(`${PLAYLIST_DIRECTORY}/`) &&
    !path.slice(PLAYLIST_DIRECTORY.length + 1).includes("/") &&
    /^[^.].*\.m3u8?$/i.test(path.slice(PLAYLIST_DIRECTORY.length + 1))
  );
}

export function isEditablePlaylist(path) {
  return isPlaylistPath(path) && /\.m3u8$/i.test(path);
}

export function playlistPath(name) {
  const clean = String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  if (!clean) throw new Error("Enter a playlist name.");
  return `${PLAYLIST_DIRECTORY}/${clean}.m3u8`;
}

export function resolveEntry(entry, path) {
  const value = entry.trim().replaceAll("\\", "/").normalize("NFC");
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/"))
    return null;
  const parts = directoryOf(path).split("/").filter(Boolean);
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function relative(target, path) {
  const from = directoryOf(path).split("/").filter(Boolean);
  const to = target.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared])
    shared++;
  const value = [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
  return value.startsWith("#") ? `./${value}` : value;
}

export function editableText(text) {
  if (String(text).includes("\uFFFD"))
    throw new Error("This playlist is not valid UTF-8 and cannot be changed here.");
  return text;
}

function lines(text) {
  return String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n|\r/);
}

export function parsePlaylist(text, path) {
  let name = null;
  const entries = [];
  lines(text).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    if (comment(value)) {
      if (/^#PLAYLIST:/i.test(value)) name = value.slice(10).trim() || name;
      return;
    }
    entries.push({ line: index, path: resolveEntry(value, path) });
  });
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.m3u8?$/i, "");
  return { name: name || base, entries };
}

function join(rows, text) {
  const body = rows.join(newline(text));
  return `${String(text ?? "").startsWith("﻿") ? "﻿" : ""}${body.endsWith(newline(text)) || !body ? body : body + newline(text)}`;
}

export function createPlaylist(name, path, tracks = []) {
  return `#EXTM3U\n#PLAYLIST:${String(name).replace(/[\r\n]/g, " ").trim()}\n${tracks
    .map((track) => `${relative(track, path)}\n`)
    .join("")}`;
}

export function appendEntry(text, path, track) {
  const wanted = track.normalize("NFC");
  if (parsePlaylist(text, path).entries.some((entry) => entry.path === wanted))
    throw new Error("This track is already in this playlist.");
  const rows = lines(text);
  while (rows.length && !rows.at(-1).trim()) rows.pop();
  rows.push(relative(track, path));
  return join(rows, text);
}

export function removeEntry(text, path, position, track) {
  const rows = lines(text);
  const entry = parsePlaylist(text, path).entries[position];
  if (!entry || entry.path !== track) return null;
  const drop = new Set([entry.line]);
  for (let index = entry.line - 1; index >= 0 && comment(rows[index]); index--)
    if (/^#EXTINF:/i.test(rows[index].trim())) drop.add(index);
  return join(
    rows.filter((_, index) => !drop.has(index)),
    text,
  );
}

export function renamePlaylist(text, name) {
  const title = `#PLAYLIST:${String(name).replace(/[\r\n]/g, " ").trim()}`;
  const rows = lines(text);
  const at = rows.findIndex((line) => /^#PLAYLIST:/i.test(line.trim()));
  if (at >= 0) rows[at] = title;
  else if (/^#EXTM3U/i.test(rows[0]?.trim() || "")) rows.splice(1, 0, title);
  else rows.unshift("#EXTM3U", title);
  return join(rows, text);
}

export function moveTrack(text, path, from, to) {
  const rows = lines(text);
  let changed = false;
  for (const entry of parsePlaylist(text, path).entries) {
    if (!entry.path) continue;
    let target = null;
    if (entry.path === from) target = to;
    else if (entry.path.startsWith(`${from}/`))
      target = `${to}${entry.path.slice(from.length)}`;
    if (!target) continue;
    rows[entry.line] = relative(target, path);
    changed = true;
  }
  return changed ? join(rows, text) : null;
}
