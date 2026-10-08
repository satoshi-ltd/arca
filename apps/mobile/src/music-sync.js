import { isHubUnreachable } from "../../desktop/src/notice-contract.js";
import { builtinExcluded } from "../../../packages/core/builtin-exclusions.js";
import {
  isPlaylistPath,
  PLAYLIST_BYTES,
  PLAYLIST_DIRECTORY,
} from "../../../packages/core/playlist.js";
import {
  buildLibrary,
  coverKeys,
  encodeHistory,
  nativeLibrary,
  parseHistory,
  recordHistory,
} from "./music-library.js";
import { folderIgnored } from "./hub-gallery.js";

export const COVERS_PER_CYCLE = 120;
export const PARTIAL_REFRESH_MS = 60000;
const SIZES = ["small", "large"];

const stopped = (error) =>
  error?.code === "SYNC_INTERRUPTED" ||
  error?.code === "REQUEST_CANCELLED" ||
  isHubUnreachable(error);

export function isMusicFolder(catalog, id) {
  return (
    !!catalog?.music && !!catalog.volumes?.some((v) => v.id === id && v.music)
  );
}

export async function musicFolders(replica) {
  if (!replica.scope) return [];
  const catalog = replica.client.state().catalog;
  const folders = [];
  for (const folder of await replica.store.folders(replica.scope))
    if (
      folder.selected &&
      isMusicFolder(catalog, folder.id) &&
      !(await replica.store.get(`removing:${replica.scope}:${folder.id}`, false))
    )
      folders.push(folder);
  return folders;
}

export async function folderExclusion(replica, volume) {
  const file = replica.files.work(replica.scope, volume, ".arcaignore");
  const ignored = folderIgnored(
    (await replica.files.exists(file)) ? await replica.files.text(file) : "",
  );
  return (path) =>
    builtinExcluded(path) || (path !== ".arcaignore" && !!ignored?.(path));
}

async function localPlaylists(replica, id) {
  const texts = new Map();
  let names, excluded;
  try {
    excluded = await folderExclusion(replica, id);
    const directory = replica.files.work(replica.scope, id, PLAYLIST_DIRECTORY);
    names = (await replica.files.exists(directory))
      ? await replica.files.listNames(directory)
      : [];
  } catch {
    return null;
  }
  for (const name of names) {
    const path = `${PLAYLIST_DIRECTORY}/${name.normalize("NFC")}`;
    if (isPlaylistPath(path) && !excluded(path))
      try {
        const uri = replica.files.work(replica.scope, id, path);
        if ((await replica.files.stat(uri))?.size > PLAYLIST_BYTES) continue;
        texts.set(path, await replica.files.text(uri));
      } catch {
        continue;
      }
  }
  return texts;
}

function replay(library, present, journal) {
  let tracks = Array.isArray(library.tracks) ? library.tracks : [];
  let playlists = Array.isArray(library.playlists) ? library.playlists : undefined;
  for (const op of journal) {
    const from = op.kind === "remove" ? op.path : op.from;
    tracks =
      op.kind === "remove"
        ? tracks.filter((track) => track.path !== from)
        : tracks.map((track) => (track.path === from ? { ...track, path: op.to } : track));
    playlists = playlists?.filter((list) => list.path !== from);
    if (op.kind === "rename" && present.has(from)) present.set(op.to, present.get(from));
    present.delete(from);
  }
  return { ...library, tracks, ...(playlists && { playlists }) };
}

async function source(replica, id, saved) {
  const present = new Map();
  for (const row of await replica.store.rows(replica.scope, id))
    if (!row.deleted && !row.directory && row.hash) present.set(row.path, row.hash);
  const journal = await replica.store.get(`journal:${replica.scope}:${id}`, []);
  return {
    id,
    library: Array.isArray(journal) && journal.length ? replay(saved.value, present, journal) : saved.value,
    present,
    playlists: await localPlaylists(replica, id),
    uri: (path) => replica.files.work(replica.scope, id, path),
  };
}

export async function localLibrary(replica, folders) {
  const sources = [];
  for (const folder of folders) {
    const saved = await replica.store.musicLibrary(replica.scope, folder.id);
    if (saved) sources.push(await source(replica, folder.id, saved));
  }
  return buildLibrary(sources);
}

export async function folderLibrary(replica, id) {
  const saved = await replica.store.musicLibrary(replica.scope, id);
  return {
    saved: !!saved,
    indexing: !!saved?.indexing,
    library: buildLibrary(saved ? [await source(replica, id, saved)] : []),
  };
}

async function fetchLibraries(replica, folders) {
  let changed = false;
  const fresh = [];
  for (const folder of folders) {
    replica.check();
    const saved = await replica.store.musicVersion(replica.scope, folder.id);
    const query = new URLSearchParams({ volume: folder.id });
    if (saved) query.set("version", saved.version);
    try {
      const value = await replica.client.api(`/v1/music/library?${query}`);
      if (value.unchanged) {
        if (saved && !!saved.indexing !== !!value.indexing) {
          await replica.store.setMusicIndexing(replica.scope, folder.id, value.indexing);
          changed = true;
        }
        fresh.push(folder.id);
      } else if (Array.isArray(value.tracks) && value.version) {
        await replica.store.saveMusicLibrary(replica.scope, folder.id, value);
        changed = true;
        fresh.push(folder.id);
      }
    } catch (error) {
      if (stopped(error)) throw error;
    }
  }
  return { changed, fresh };
}

async function fetchCovers(replica, library) {
  replica.coverMisses ||= new Set();
  const owners = new Map();
  for (const track of library.tracks.values())
    if (track.cover && !owners.has(track.cover)) owners.set(track.cover, track.folder);
  let requested = 0;
  let fetched = 0;
  let complete = true;
  for (const [key, volume] of owners)
    for (const size of SIZES) {
      const target = replica.files.musicCover(replica.scope, key, size);
      if (replica.coverMisses.has(`${key}-${size}`) || (await replica.files.exists(target)))
        continue;
      if (requested >= COVERS_PER_CYCLE) return { complete: false, fetched };
      replica.check();
      requested++;
      let value;
      try {
        value = await replica.client.api(
          `/v1/music/cover?${new URLSearchParams({ volume, key, size })}`,
        );
      } catch (error) {
        if (stopped(error)) throw error;
        if (error?.status === 404) replica.coverMisses.add(`${key}-${size}`);
        else complete = false;
        continue;
      }
      if (value?.retry) {
        complete = false;
        continue;
      }
      if (typeof value?.data !== "string") {
        replica.coverMisses.add(`${key}-${size}`);
        continue;
      }
      await replica.files.mkdir(replica.files.parent(target));
      const staged = `${target}.part`;
      await replica.files.remove(staged);
      await replica.files.writeBase64(staged, value.data.slice(value.data.indexOf(",") + 1));
      await replica.files.replace(staged, target);
      fetched++;
    }
  return { complete, fetched };
}

async function pruneCovers(replica, library) {
  const directory = replica.files.musicCovers(replica.scope);
  if (!(await replica.files.exists(directory))) return;
  const keys = coverKeys(library);
  for (const name of await replica.files.listNames(directory)) {
    const match = /^([a-f0-9]{64})-(small|large)\.jpg(\.part)?$/.exec(name);
    if (match && (!keys.has(match[1]) || match[3]))
      await replica.files.remove(
        replica.files.musicCover(replica.scope, match[1], match[2]) + (match[3] || ""),
      );
  }
}

export function publishMusic(replica, library = null) {
  const run = (replica.musicPublishing || Promise.resolve())
    .catch(() => {})
    .then(() => writeLibrary(replica, library));
  replica.musicPublishing = run;
  return run;
}

async function writeLibrary(replica, library) {
  if (!replica.player || !replica.files.musicLibrary || !replica.scope) return;
  library ||= await localLibrary(replica, await musicFolders(replica));
  const text = JSON.stringify(nativeLibrary(library, replica.scope));
  if (text === replica.publishedMusic) return;
  replica.publishedMusic = null;
  const target = replica.files.musicLibrary();
  const staged = `${target}.part`;
  await replica.files.mkdir(replica.files.parent(target));
  await replica.files.remove(staged);
  await replica.files.write(staged, new TextEncoder().encode(text));
  await replica.files.replace(staged, target);
  await replica.player.reload?.(target);
  replica.publishedMusic = text;
}

export async function refreshMusic(replica, { covers = true } = {}) {
  if (!replica.files.musicLibrary) return;
  if (!covers && Date.now() - (replica.musicRefreshed || 0) < PARTIAL_REFRESH_MS) return;
  replica.musicRefreshed = Date.now();
  const folders = await musicFolders(replica);
  let changed = false;
  try {
    const fetched = folders.length ? await fetchLibraries(replica, folders) : { changed: false, fresh: [] };
    changed = fetched.changed;
    for (const id of fetched.fresh)
      if (replica.journalCut?.has(id)) {
        await replica.forgetLocal(id, replica.journalCut.get(id));
        replica.journalCut.delete(id);
      }
    const library = await localLibrary(replica, folders);
    const ready = [...library.tracks.keys()].join("\u0000");
    if (replica.musicReady !== undefined && ready !== replica.musicReady) changed = true;
    replica.musicReady = ready;
    await publishMusic(replica, library);
    if (covers) {
      const result = folders.length ? await fetchCovers(replica, library) : { complete: true, fetched: 0 };
      if (result.fetched) changed = true;
      if (result.complete) await pruneCovers(replica, library);
    }
  } catch {
    /* The saved library and covers stay usable; the next cycle retries. */
  } finally {
    if (changed) replica.musicTick = (replica.musicTick || 0) + 1;
  }
}

export async function readMusicHistory(replica) {
  if (!replica.files.musicHistory || !replica.scope) return [];
  const target = replica.files.musicHistory();
  try {
    if (!(await replica.files.exists(target))) return [];
    return parseHistory(await replica.files.text(target), replica.scope);
  } catch {
    return [];
  }
}

function changeMusicHistory(replica, change) {
  const run = (replica.musicHistoryWriting || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!replica.files.musicHistory || !replica.scope) return;
      const scope = replica.scope;
      const next = change(await readMusicHistory(replica));
      const target = replica.files.musicHistory();
      const staged = `${target}.part`;
      await replica.files.mkdir(replica.files.parent(target));
      await replica.files.remove(staged);
      await replica.files.write(
        staged,
        new TextEncoder().encode(encodeHistory(scope, next)),
      );
      await replica.files.replace(staged, target);
    });
  replica.musicHistoryWriting = run;
  return run;
}

export const recordMusicPlay = (replica, context) =>
  changeMusicHistory(replica, (history) => recordHistory(history, context));

export const renameMusicPlay = (replica, from, to) =>
  replica.player
    ? replica.player.renameHistory(from, to)
    : changeMusicHistory(replica, (history) =>
        history.includes(from)
          ? [...new Set(history.map((id) => (id === from ? to : id)))]
          : history,
      );
