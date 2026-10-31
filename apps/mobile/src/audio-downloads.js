import { createVideoDownloads, downloadKey } from "./video-downloads.js";
import { musicMediaRoute } from "./music-library.js";
import { isMusicFolder } from "./music-sync.js";

export const AUDIO_KIND = {
  noun: "track",
  syncing: "Waiting for the hub to finish syncing this track.",
  rows: "audioDownloads",
  save: "saveAudioDownload",
  foreign: "foreignAudioDownloads",
  forget: "forgetAudioDownload",
  file: "audioDownload",
  route: musicMediaRoute,
  subtitles: () => [],
  belongs: isMusicFolder,
  async current({ scope, store, client }, volume, path) {
    const value = await client.api(`/v1/music/library?${new URLSearchParams({ volume })}`);
    if (Array.isArray(value?.tracks) && value.version) await store.saveMusicLibrary(scope, volume, value);
    return (value?.tracks || []).find((item) => item?.path === path) || null;
  },
  paths(library) {
    if (!Array.isArray(library?.tracks) || library.indexing || !library.tracks.length) return null;
    return new Set(library.tracks.map((item) => item?.path));
  },
  verify: async (files, uri, row) => (await files.hash(uri)) === row.hash,
};

export const createAudioDownloads = (options) => createVideoDownloads({ ...options, kind: AUDIO_KIND });

export function audioTargets(library, kind, id) {
  const track = (key) => library.tracks.get(key) || library.pending.get(key);
  const rows = (ids) => (ids || []).map(track).filter(Boolean);
  if (kind === "track") return rows([id]);
  if (kind === "album") return rows(library.albums.get(id)?.rows);
  if (kind === "show") return rows(library.shows.get(id)?.rows);
  const artist = library.artists.find((entry) => entry.id === id);
  return (artist?.albums || []).flatMap((album) => rows(library.albums.get(album)?.rows));
}

export function audioActions(rows) {
  const actions = [];
  if (rows.some((row) => !row || row.state === "failed" || row.state === "stale")) actions.push("download");
  if (rows.some((row) => row?.state === "queued" || row?.state === "waiting")) actions.push("cancel-download");
  if (rows.some((row) => row?.state === "done")) actions.push("remove-download");
  return actions;
}

export const audioRows = (rows, volume, tracks) =>
  tracks.map((track) => {
    const row = rows.get(downloadKey(volume, track.path)) || null;
    return row && row.state === "done" && row.hash !== track.hash ? { ...row, state: "stale" } : row;
  });
