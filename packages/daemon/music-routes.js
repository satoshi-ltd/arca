import { streamGalleryMedia } from "./gallery-media.js";
import { fail } from "./storage.js";
import { forward, proxy } from "./video-routes.js";

export const MUSIC_OFFLINE = "Connect to your hub to listen";

export const trackOf = (library, name) => (library?.tracks || []).find((track) => track.path === name) || null;

export async function fromHub(engine, route, stop = null, body = undefined) {
  try {
    return await forward(engine, route, body, undefined, stop);
  } catch (error) {
    if (error.status === 503) fail(MUSIC_OFFLINE, 503);
    throw error;
  }
}

export async function streamedLibrary(context, volume, known, stop = null) {
  const { engine, s } = context;
  const key = `${engine.config.hub?.id || ""}:music-library:${volume}`;
  const saved = s.db.prepare("SELECT value FROM remote_views WHERE key=?").get(key);
  const cached = saved ? JSON.parse(saved.value) : null;
  if (saved) s.db.prepare("UPDATE remote_views SET used=? WHERE key=?").run(Date.now(), key);
  let value;
  try {
    const route = (version) => `/v1/music/library?${new URLSearchParams({ volume, ...(version ? { version } : {}) })}`;
    const answer = await fromHub(engine, route(cached?.version), stop);
    if (stop?.aborted) throw stop.reason;
    if (answer.unchanged && cached) value = { ...cached, indexing: answer.indexing };
    else if (answer.unchanged) value = await fromHub(engine, route(null), stop);
    else value = answer;
    engine.videoDownloads?.pruneMusic(volume, value);
    if (!value.unchanged) {
      s.db.prepare("INSERT OR REPLACE INTO remote_views(key,value,used) VALUES(?,?,?)").run(key, JSON.stringify(value), Date.now());
      s.db.exec("DELETE FROM remote_views WHERE key NOT IN (SELECT key FROM remote_views ORDER BY used DESC LIMIT 64)");
    }
  } catch (error) {
    const downloaded = error.status === 503 && !cached ? engine.videoDownloads?.offlineMusic(volume) : null;
    if (error.status !== 503 || !(cached || downloaded)) throw error;
    value = downloaded || { ...cached, offline: true };
  }
  if (known && known === value.version)
    return { version: value.version, indexing: value.indexing, unchanged: true, ...(value.offline ? { offline: true } : {}) };
  return value;
}

export async function streamedCover(context, volume, key, size) {
  try {
    return await fromHub(context.engine, `/v1/music/cover?${new URLSearchParams({ volume, key: String(key ?? ""), size })}`);
  } catch (error) {
    const data = error.status === 503 ? context.engine.videoDownloads?.coverData(volume, key, size) : null;
    if (!data) throw error;
    return { data };
  }
}

export function streamedMedia(context, volume, name, hash) {
  const local = context.engine.videoDownloads?.local(volume, name, hash);
  if (local) return streamGalleryMedia(context.req, context.res, local);
  return proxy(context, `/v1/music/media?${new URLSearchParams({ volume, path: name, hash })}`, { offline: MUSIC_OFFLINE });
}

export async function streamedTrack(context, volume, name, hash) {
  if (typeof volume !== "string" || typeof name !== "string" || !/^[a-f0-9]{64}$/.test(hash || "")) fail("Invalid track");
  const local = context.engine.videoDownloads?.local(volume, name, hash);
  let library;
  try {
    library = await streamedLibrary(context, volume, null);
  } catch (error) {
    if (error.status !== 503 || !local) throw error;
    return;
  }
  const track = trackOf(library, name);
  if (!local && (!track || track.hash !== hash)) fail("This track is no longer available", 404);
  if (library.offline && !local) fail(MUSIC_OFFLINE, 503);
}
