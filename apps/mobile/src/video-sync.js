import { isHubUnreachable } from "../../desktop/src/notice-contract.js";
import { isLanHost } from "./network-policy.js";
import { embeddedStream, parseCues, subtitleRoute } from "./subtitles.js";
import { compatibleRoute, needsCompatible } from "./video-compatible.js";
import { MIN_POSITION, artKeys, artRoute, libraryRoute, mediaRoute, normalizeLibrary, positionBody } from "./video-library.js";

export const ART_CONCURRENCY = 2;
export const PART_GRACE = 5 * 60 * 1000;
export const EMBEDDED_TIMEOUT = 30 * 60 * 1000;
export const PREPARING_POLL = 3000;
export const WATCH_OFFLINE = "Connect to your hub to watch";
const LAN_TYPES = new Set(["WIFI", "ETHERNET"]);

export function isVideoFolder(catalog, id) {
  return !!catalog?.video && !!catalog.volumes?.some((v) => v.id === id && v.video);
}

export const acceptsWrites = (catalog, folder) => !!folder?.selected && !isVideoFolder(catalog, folder.id);

export async function cachedVideoLibrary(replica, volume) {
  const saved = replica?.scope ? await replica.store.videoLibrary(replica.scope, volume).catch(() => null) : null;
  return saved ? normalizeLibrary(saved.value) : null;
}

export function videoWrite(replica, scope, write) {
  if (!scope || replica.scope !== scope) return Promise.resolve(false);
  if (!replica.videoWrites) replica.videoWrites = new Set();
  const job = Promise.resolve().then(write).then(() => true);
  replica.videoWrites.add(job);
  job.catch(() => {}).finally(() => replica.videoWrites.delete(job));
  return job;
}

const ERASED = "This device was erased.";

export const videoModesKey = (scope) => `video-modes:${scope}`;

export async function videoModes(replica) {
  if (!replica?.scope) return {};
  const value = await replica.store.get(videoModesKey(replica.scope), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function refreshVideoLibrary(replica, volume, { signal, downloads = null, platform = null } = {}) {
  const fresh = await readVideoLibrary(replica, volume, { signal });
  await downloads?.prune(volume, fresh.library);
  const kept = async () => !replica.removing && (await videoModes(replica))[volume] === "keep";
  if (downloads && platform && (await kept())) await downloads.keep(volume, fresh.library, platform, kept);
  return fresh;
}

export async function keepVideoLibraries(replica, downloads, platform) {
  for (const [volume, mode] of Object.entries(await videoModes(replica)))
    if (mode === "keep" && !replica.removing) await refreshVideoLibrary(replica, volume, { downloads, platform }).catch(() => null);
}

async function readVideoLibrary(replica, volume, { signal } = {}) {
  const scope = replica.scope;
  const saved = await replica.store.videoLibrary(scope, volume).catch(() => null);
  const value = await replica.client.api(libraryRoute(volume, saved?.version), undefined, signal ? { signal } : {});
  if (value?.unchanged && saved) {
    if (!!saved.value.indexing !== !!value.indexing || !!saved.value.matching !== !!value.matching) {
      const next = { ...saved.value, indexing: !!value.indexing, matching: !!value.matching };
      if (!(await videoWrite(replica, scope, () => replica.store.saveVideoLibrary(scope, volume, next)))) throw new Error(ERASED);
      return { changed: true, library: normalizeLibrary(next) };
    }
    return { changed: false, library: normalizeLibrary(saved.value) };
  }
  if (!value || typeof value.version !== "string" || !Array.isArray(value.movies)) throw new Error("The hub returned an invalid video library.");
  if (!(await videoWrite(replica, scope, () => replica.store.saveVideoLibrary(scope, volume, value)))) throw new Error(ERASED);
  return { changed: true, library: normalizeLibrary(value) };
}

export async function pruneVideoLibraries(replica, catalog) {
  if (!replica?.scope || !catalog?.volumes) return;
  const scope = replica.scope;
  const kept = catalog.volumes.filter((v) => isVideoFolder(catalog, v.id)).map((v) => v.id);
  await replica.store.pruneVideoLibraries(scope, kept);
  if (!catalog.volumes.length) return;
  const modes = await videoModes(replica);
  const gone = Object.keys(modes).filter((id) => !kept.includes(id));
  if (gone.length) await replica.store.set(videoModesKey(scope), Object.fromEntries(Object.entries(modes).filter(([id]) => !gone.includes(id))));
}

export async function pruneVideoArt(replica, now = Date.now()) {
  if (!replica?.scope || !replica.files.videoArts) return;
  const directory = replica.files.videoArts(replica.scope);
  if (!(await replica.files.exists(directory))) return;
  const keys = new Set();
  for (const saved of await replica.store.videoLibraries(replica.scope)) for (const key of artKeys(saved.value)) keys.add(key);
  for (const name of await replica.files.listNames(directory)) {
    const match = /^([a-f0-9]{64})-(small|large)\.jpg(\.part)?$/.exec(name);
    if (!match || (keys.has(match[1]) && !match[3])) continue;
    const uri = replica.files.videoArt(replica.scope, match[1], match[2]) + (match[3] || "");
    if (match[3] && !((await replica.files.stat(uri).catch(() => null))?.mtime < now - PART_GRACE)) continue;
    await replica.files.remove(uri);
  }
}

export function videoArtURI(replica, key, size) {
  if (!key || !replica?.scope) return null;
  try {
    for (const option of size === "large" ? ["large", "small"] : ["small"]) {
      const uri = replica.files.videoArt(replica.scope, key, option);
      if (!replica.files.present || replica.files.present(uri)) return uri;
    }
  } catch {
    return null;
  }
  return null;
}

export function createArtLoader(replica, onLoaded, concurrency = ART_CONCURRENCY) {
  const queue = [];
  const queued = new Set();
  const missing = new Set();
  let running = 0;
  let stopped = false;
  const pump = () => {
    while (!stopped && running < concurrency && queue.length) {
      const job = queue.shift();
      running++;
      fetchArt(job)
        .then((fetched) => fetched && !stopped && onLoaded(job))
        .catch(() => {})
        .finally(() => {
          running--;
          queued.delete(job.id);
          pump();
        });
    }
  };
  async function fetchArt({ volume, key, size, id }) {
    const scope = replica.scope;
    const target = replica.files.videoArt(scope, key, size);
    if (await replica.files.exists(target)) return false;
    let value;
    try {
      value = await replica.client.api(artRoute(volume, key, size));
    } catch (error) {
      if (error?.status === 404) missing.add(id);
      if (isHubUnreachable(error)) {
        for (const dropped of queue) queued.delete(dropped.id);
        queue.length = 0;
      }
      return false;
    }
    if (value?.retry) return false;
    if (typeof value?.data !== "string") {
      missing.add(id);
      return false;
    }
    if (stopped) return false;
    return videoWrite(replica, scope, async () => {
      await replica.files.mkdir(replica.files.parent(target));
      const staged = `${target}.part`;
      await replica.files.remove(staged);
      await replica.files.writeBase64(staged, value.data.slice(value.data.indexOf(",") + 1));
      await replica.files.replace(staged, target);
    });
  }
  return {
    request(volume, key, size) {
      if (stopped || !key || !/^[a-f0-9]{64}$/.test(key)) return;
      const id = `${key}-${size}`;
      if (queued.has(id) || missing.has(id)) return;
      queued.add(id);
      queue.push({ volume, key, size, id });
      pump();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}

export function unreachable(message = WATCH_OFFLINE) {
  return Object.assign(new Error(message), { code: "HUB_UNREACHABLE" });
}

async function hubGate(client, networkType) {
  const connection = client.state().connection;
  if (!connection?.linked) throw unreachable();
  const lan = connection.url.startsWith("http:") && isLanHost(new URL(connection.url).hostname);
  if (lan) {
    let type = null;
    try {
      type = (await networkType())?.type || null;
    } catch {
      type = null;
    }
    if (!LAN_TYPES.has(type)) throw unreachable("Connect to your hub’s Wi-Fi to watch. A local hub is never reached over mobile data.");
  }
  return lan;
}

const unreachableError = (error) => error?.code === "HUB_UNREACHABLE" || isHubUnreachable(error);

export async function videoSource({ client, volume, item, networkType, mode = "auto", start = 0, audio = null }) {
  const compatible = mode === "compatible" || (mode === "auto" && needsCompatible(item, audio));
  const lan = await hubGate(client, networkType);
  try {
    if (!compatible) return { ...(await client.stream(mediaRoute(volume, item))), lan, offset: 0 };
    const plan = await client.api(compatibleRoute(volume, item, start, audio));
    if (typeof plan?.url !== "string") throw new Error("The hub could not prepare this video.");
    return {
      ...(await client.stream(plan.url)),
      lan,
      compatible: true,
      offset: Number.isFinite(plan.offset) ? plan.offset : Math.max(0, Math.floor(start || 0)),
      audio: Number.isSafeInteger(plan.audio) ? plan.audio : audio,
      duration: Number.isFinite(plan.duration) ? plan.duration : item.duration || 0,
    };
  } catch (error) {
    if (unreachableError(error)) throw unreachable();
    throw error;
  }
}

export function savePosition(client, volume, item, position, duration) {
  return client.api("/v1/video/position", positionBody(volume, item, position, duration));
}

export function markWatched(client, volume, items, watched) {
  return items.reduce(
    (chain, item) => chain.then(() => client.api("/v1/video/watched", { volume, path: item.path, hash: item.hash, watched })),
    Promise.resolve(),
  );
}

export async function deleteVideos({ client, volume, items, removeDownloads = async () => {} }) {
  const deleted = [];
  const failed = [];
  for (const [index, item] of items.entries()) {
    try {
      await client.api("/v1/delete-file", { volume, path: item.path, rev: item.rev });
      deleted.push(item);
    } catch (error) {
      if (isHubUnreachable(error)) {
        if (!deleted.length) throw error;
        failed.push(...items.slice(index));
        break;
      }
      failed.push(item);
    }
  }
  if (deleted.length) await removeDownloads(deleted);
  return { deleted, failed };
}

export function deleteNotice({ deleted, failed }, unit) {
  const noun = (n) => (unit === "movie" ? (n === 1 ? "movie" : "movies") : n === 1 ? "episode" : "episodes");
  const total = deleted.length + failed.length;
  if (!failed.length) return unit === "movie" ? "Movie deleted." : `${deleted.length} ${noun(deleted.length)} deleted.`;
  return `Deleted ${deleted.length} of ${total} ${noun(total)}. ${failed.length} could not be removed.`;
}

export const NETWORK_LEFT = "Playback stopped: this phone left the hub’s Wi-Fi. A local hub is never reached over mobile data.";

export function watchPrivateNetwork(source, subscribe, onLeft) {
  if (!source?.lan || !subscribe) return () => {};
  let done = false;
  const subscription = subscribe((event) => {
    if (done || !(event?.type === "CELLULAR" || event?.type === "NONE" || event?.isConnected === false)) return;
    done = true;
    onLeft();
  });
  return () => {
    done = true;
    subscription?.remove?.();
  };
}

export async function subtitleText({ client, volume, path, item, signal = null, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const options = signal ? { signal } : {};
  const stopped = () => {
    if (signal?.aborted) throw signal.reason || new Error("Request cancelled");
  };
  const stream = embeddedStream(path);
  let value = stream === null ? await client.api(subtitleRoute(volume, path), undefined, options) : null;
  const until = now() + EMBEDDED_TIMEOUT;
  while (stream !== null) {
    stopped();
    value = await client.api(subtitleRoute(volume, item.path, { hash: item.hash, stream }), undefined, options);
    if (!value?.preparing) break;
    if (now() > until) throw new Error("These subtitles are taking too long. Try again later.");
    stopped();
    await pause(PREPARING_POLL);
  }
  if (typeof value?.text !== "string") throw new Error("The hub returned no subtitles.");
  return value.text;
}

export async function loadSubtitles(options) {
  return parseCues(await subtitleText(options));
}

const liveSent = new Map();
const liveKey = (scope, volume, path) => `${scope}\n${volume}\n${path}`;

export async function sendPosition({ client, replica, volume, item, position, duration, now = Date.now }) {
  const body = positionBody(volume, item, position, duration);
  const at = now();
  const queue = () => (replica?.scope ? replica.store.queueVideoPosition(replica.scope, body, at) : null);
  if (!client.state().connection?.linked) return queue();
  const key = replica?.scope ? liveKey(replica.scope, volume, item.path) : null;
  const before = key ? liveSent.get(key) || 0 : 0;
  if (key) {
    liveSent.set(key, Math.max(before, at));
    await replica.store.dropVideoPosition(replica.scope, volume, item.path, at);
  }
  try {
    await client.api("/v1/video/position", body);
  } catch (error) {
    if (!unreachableError(error)) return null;
    if (key && liveSent.get(key) === at) liveSent.set(key, before);
    return queue();
  }
  return null;
}

export async function flushPositions({ client, replica }) {
  if (!replica?.scope || !client.state().connection?.linked) return 0;
  let sent = 0;
  for (const { at, body } of await replica.store.videoPositions(replica.scope)) {
    if ((liveSent.get(liveKey(replica.scope, body.volume, body.path)) || 0) >= at) {
      await replica.store.dropVideoPosition(replica.scope, body.volume, body.path, at);
      continue;
    }
    try {
      await client.api("/v1/video/position", body);
      sent++;
    } catch (error) {
      if (unreachableError(error)) break;
    }
    await replica.store.dropVideoPosition(replica.scope, body.volume, body.path, at);
  }
  return sent;
}

export async function withQueuedPositions(replica, volume, library) {
  if (!library || !replica?.scope) return library;
  const rows = await replica.store.videoPositions(replica.scope, volume).catch(() => []);
  if (!rows.length) return library;
  const byPath = new Map(rows.map((row) => [row.body.path, row]));
  for (const item of library.items.values()) {
    const row = item.kind !== "show" && byPath.get(item.path);
    if (!row || row.body.hash !== item.hash || row.body.position < MIN_POSITION) continue;
    const { position, duration } = row.body;
    if (position >= duration - Math.min(Math.max(120, duration * 0.05), duration * 0.1)) {
      item.position = null;
      item.watched = true;
    } else item.position = { position, duration, updated: row.at, device: null };
  }
  return library;
}
