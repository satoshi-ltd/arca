import fs from "node:fs";
import { Readable } from "node:stream";
import { streamGalleryMedia } from "./gallery-media.js";
import { digest, fail, token } from "./storage.js";
import { PREPARING } from "./video.js";
import { CLIENT_AUDIO, STREAMABLE_VIDEO, keyframeBefore } from "./video-sessions.js";

export const VIDEO_OFFLINE = "Connect to your hub to watch";
export const VIDEO_TICKET_ROUTES = ["/v1/video/media"];
const LOOPBACK = ["127.0.0.1", "::1"];
const TICKET_MS = 2 * 3600000;
const PROXY_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];
const EXTRACTION_WAIT_MS = 30 * 60000;
const probes = new Map();
const HUB_ONLY = "Manage video settings and matches on the hub";
const DOWNLOADS_ONLY = "Only the desktop app downloads videos";
const DOWNLOAD_ROUTES = ["/v1/video/download", "/v1/video/download/cancel", "/v1/video/download/remove"];
const MANAGED = ["/v1/video/settings", "/v1/video/tmdb-search", "/v1/video/tmdb-image", "/v1/video/match", "/v1/video/kids", "/v1/video/refresh"];

function hubError(error) {
  if (error.hubUnavailable || error.name === "AbortError" || error.name === "TimeoutError") return Object.assign(new Error(VIDEO_OFFLINE), { status: 503 });
  const detail = /^Hub \d+: ([\s\S]*)$/.exec(error.message || "")?.[1];
  if (detail && error.status) {
    try {
      const parsed = JSON.parse(detail);
      if (typeof parsed?.error === "string") return Object.assign(new Error(parsed.error), { status: error.status });
    } catch {
      return error;
    }
  }
  return error;
}

export function issueVideoTicket(tickets, value) {
  for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
  while (tickets.size >= 32) tickets.delete(tickets.keys().next().value);
  const ticket = token();
  tickets.set(ticket, { ...value, expires: Date.now() + TICKET_MS });
  return ticket;
}

export async function forward(engine, route, body, timeout = body === undefined ? 10000 : 15000, stop = null) {
  if (!engine.config.hub || engine.hubUnavailable) fail(VIDEO_OFFLINE, 503);
  try {
    return await engine.json(route, body, {
      signal: stop ? AbortSignal.any([stop, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      trackConnection: false,
    });
  } catch (error) {
    throw hubError(error);
  }
}

async function proxy(context, route, { text = false, timeout = null } = {}) {
  const { engine, req, res } = context;
  const hub = engine.config.hub;
  if (!hub || engine.hubUnavailable) fail(VIDEO_OFFLINE, 503);
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  let idle;
  const wait = (ms) => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new DOMException("The hub stopped sending", "TimeoutError")), ms);
  };
  wait(timeout ?? engine.videoProxyTimeoutMs ?? 15000);
  let response;
  try {
    response = await fetch(`${hub.url}${route}`, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${hub.token}`, ...(req.headers.range && !text ? { Range: req.headers.range } : {}) },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(idle);
    res.off("close", close);
    fail(VIDEO_OFFLINE, 503);
  }
  if ([502, 503, 504].includes(response.status) && !(response.status === 502 && /json/.test(response.headers.get("content-type") || ""))) {
    clearTimeout(idle);
    res.off("close", close);
    fail(VIDEO_OFFLINE, 503);
  }
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  for (const name of PROXY_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(response.status, headers);
  if (!response.body || req.method === "HEAD") {
    clearTimeout(idle);
    res.end();
    return;
  }
  const idleMs = engine.videoIdleMs ?? 60000;
  wait(idleMs);
  Readable.fromWeb(response.body)
    .on("data", () => wait(idleMs))
    .on("pause", () => clearTimeout(idle))
    .on("resume", () => wait(idleMs))
    .on("end", () => clearTimeout(idle))
    .on("error", () => {
      clearTimeout(idle);
      res.destroy();
    })
    .pipe(res);
}

function sendText(res, req, value) {
  const data = Buffer.from(value, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/vtt; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

export async function streamVideo(context, volume, name, hash) {
  const { video, req, res, config } = context;
  if (config.role === "hub") {
    const media = video.media(volume, name, hash);
    if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) video.warmSubtitles(volume, name, hash);
    return streamGalleryMedia(req, res, media);
  }
  const local = context.engine.videoDownloads?.local(volume, name, hash);
  if (local) return streamGalleryMedia(req, res, local);
  return proxy(context, `/v1/video/media?${new URLSearchParams({ volume, path: name, hash })}`);
}

export async function sendSubtitles(context, volume, name, json = false, embedded = null) {
  const { video, req, res, config, engine } = context;
  const answer = (text) => (text === PREPARING ? context.send(202, { preparing: true }) : json ? context.send(200, { text }) : sendText(res, req, text));
  const poll = !!embedded?.poll && json;
  const read = () =>
    embedded ? video.embeddedSubtitles(volume, name, embedded.hash, embedded.stream, { wait: !poll }) : video.subtitles(volume, name);
  const query = { volume, path: name, ...(embedded ? { hash: embedded.hash, stream: String(embedded.stream), ...(poll ? { poll: "1" } : {}) } : {}) };
  if (config.role === "hub") return answer(await read());
  const local = () => engine.videoDownloads?.subtitle(volume, name, embedded);
  if (embedded && typeof local() === "string") return answer(local());
  const wait = embedded && !poll ? EXTRACTION_WAIT_MS : undefined;
  try {
    if (json) {
      const value = await forward(engine, `/v1/video/subtitles?${new URLSearchParams({ ...query, format: "json" })}`, undefined, wait);
      return answer(value?.preparing ? PREPARING : value.text);
    }
    return await proxy(context, `/v1/video/subtitles?${new URLSearchParams(query)}`, { text: true, ...(wait ? { timeout: wait } : {}) });
  } catch (error) {
    const saved = error.status === 503 && !res.headersSent ? local() : null;
    if (typeof saved !== "string") throw error;
    return answer(saved);
  }
}

function embeddedQuery(query) {
  if (!query.has("stream")) return null;
  const stream = Number(query.get("stream"));
  if (!/^\d{1,2}$/.test(query.get("stream")) || !/^[a-f0-9]{64}$/.test(query.get("hash") || "")) fail("Invalid subtitles");
  return { hash: query.get("hash"), stream, poll: query.get("poll") === "1" };
}

export async function replicaLibrary(context, volume, known, stop = null) {
  const { engine, s } = context;
  const key = `${engine.config.hub?.id || ""}:video-library:${volume}`;
  const saved = s.db.prepare("SELECT value FROM remote_views WHERE key=?").get(key);
  const cached = saved ? JSON.parse(saved.value) : null;
  if (saved) s.db.prepare("UPDATE remote_views SET used=? WHERE key=?").run(Date.now(), key);
  let value;
  try {
    const answer = await forward(
      engine,
      `/v1/video/library?${new URLSearchParams({ volume, ...(cached?.version ? { version: cached.version } : {}) })}`,
      undefined,
      undefined,
      stop,
    );
    if (stop?.aborted) throw stop.reason;
    if (answer.unchanged && cached) value = { ...cached, indexing: answer.indexing, matching: answer.matching, tmdb: answer.tmdb };
    else if (answer.unchanged) value = await forward(engine, `/v1/video/library?${new URLSearchParams({ volume })}`, undefined, undefined, stop);
    else value = answer;
    engine.videoDownloads?.pruneLibrary(volume, value);
    if (!value.unchanged) {
      s.db.prepare("INSERT OR REPLACE INTO remote_views(key,value,used) VALUES(?,?,?)").run(key, JSON.stringify(value), Date.now());
      s.db.exec("DELETE FROM remote_views WHERE key NOT IN (SELECT key FROM remote_views ORDER BY used DESC LIMIT 64)");
    }
  } catch (error) {
    const downloaded = error.status === 503 && !cached ? engine.videoDownloads?.offlineLibrary(volume) : null;
    if (error.status !== 503 || !(cached || downloaded)) throw error;
    value = downloaded || { ...cached, offline: true };
    if (engine.videoDownloads) value = engine.videoDownloads.queued(volume, value);
  }
  if (known && known === value.version)
    return {
      version: value.version,
      indexing: value.indexing,
      matching: value.matching,
      tmdb: value.tmdb,
      unchanged: true,
      ...(value.offline ? { offline: true } : {}),
    };
  return value;
}

export function fileOf(library, name) {
  for (const item of [...(library.movies || []), ...(library.other || [])]) if (item.path === name) return item;
  for (const show of library.shows || [])
    for (const season of show.seasons || []) for (const episode of season.episodes || []) if (episode.path === name) return episode;
  return null;
}

const HLS = /^\/v1\/video\/hls\/([a-f0-9]{32})\/([^/]+)$/;
export const hlsSession = (pathname) => HLS.exec(pathname)?.[1] || null;
export const PLAYER_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:1425"];
export const loopbackAllowed = (session, method, remote, origin) =>
  !!session?.loopback && ["GET", "HEAD"].includes(method) && LOOPBACK.includes(remote) && (!origin || PLAYER_ORIGINS.includes(origin));
const ownerOf = (context) =>
  context.browserSession
    ? `browser:${digest(/(?:^|;\s*)arca_session=([a-f0-9]{64})(?:;|$)/.exec(context.req.headers.cookie || "")?.[1] || "")}`
    : digest(context.credential || "");

export const playlistFromStart = (text) =>
  text.includes("#EXT-X-START") ? text : text.replace(/^#EXTM3U\r?\n/, "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n");

export async function serveHls(context, session, pathname) {
  if (session.remote) return proxy(context, pathname, { timeout: 45000 });
  const media = await context.sessions.file(session, HLS.exec(pathname)[2]);
  if (media.type === "application/vnd.apple.mpegurl") {
    const body = Buffer.from(playlistFromStart(fs.readFileSync(media.file, "utf8")));
    context.res.writeHead(200, {
      "Content-Type": media.type,
      "Content-Length": body.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return void context.res.end(context.req.method === "HEAD" ? undefined : body);
  }
  const size = fs.statSync(media.file).size;
  return streamGalleryMedia(context.req, context.res, { ...media, size });
}

async function compatible(context) {
  const { url, admin, browserSession, remote, config, video, sessions, engine } = context;
  const query = url.searchParams;
  const volume = query.get("volume");
  const name = query.get("path");
  const hash = query.get("hash");
  if (typeof volume !== "string" || typeof name !== "string" || !/^[a-f0-9]{64}$/.test(hash || "")) fail("Invalid video");
  if (query.has("start") && !/^\d{1,7}(\.\d{1,6})?$/.test(query.get("start"))) fail("Invalid start");
  const start = Number(query.get("start") || 0);
  const chosen = query.has("audio") ? Number(query.get("audio")) : null;
  if (chosen !== null && !(Number.isSafeInteger(chosen) && chosen >= 0 && chosen < 100)) fail("Invalid audio track");
  const owner = ownerOf(context);
  const sequence = sessions.next(owner);
  const latest = () => {
    if (!sessions.current(owner, sequence)) fail("A newer playback request replaced this one", 409);
  };
  const loopback = admin && !browserSession && LOOPBACK.includes(remote);
  const address = (id) => `${loopback ? `http://127.0.0.1:${context.port()}` : ""}/v1/video/hls/${id}/index.m3u8`;
  const launch = async (file, item) => {
    const tracks = item.audioTracks || [];
    if (chosen !== null && !tracks.some((track) => track.stream === chosen)) fail("Invalid audio track");
    const audio = tracks.length ? (chosen ?? tracks.find((track) => track.default)?.stream ?? tracks[0].stream) : null;
    if (item.videoCodec && !STREAMABLE_VIDEO.has(item.videoCodec)) fail("This video's format can't be streamed. Play it in an app that opens the file directly.", 415);
    probes.get(owner)?.abort();
    const controller = new AbortController();
    probes.set(owner, controller);
    let offset;
    try {
      offset = await keyframeBefore(sessions.binary, file, start, controller.signal, name);
    } finally {
      if (probes.get(owner) === controller) probes.delete(owner);
    }
    latest();
    const session = sessions.start({
      owner,
      loopback,
      source: file,
      name,
      start,
      audio: audio ?? 0,
      videoCodec: item.videoCodec,
      audioCodec: tracks.find((track) => track.stream === audio)?.codec ?? item.audioCodec,
      audioChannels: tracks.find((track) => track.stream === audio)?.channels ?? null,
      copy: (query.get("copy") || "").split(",").filter((codec) => CLIENT_AUDIO.has(codec)),
    });
    return { url: address(session.id), offset, audio, duration: item.duration ?? null };
  };
  if (config.role === "hub") {
    const media = video.media(volume, name, hash);
    const item = video.entry(volume, name);
    if (!item) fail("This video is no longer available", 404);
    video.warmSubtitles(volume, name, hash);
    return launch(media.file, item);
  }
  const local = engine.videoDownloads?.local(volume, name, hash);
  if (local?.item) return launch(local.file, local.item);
  const answer = await forward(engine, `/v1/video/compatible?${query}`);
  latest();
  const id = HLS.exec(answer.url || "")?.[1];
  sessions.remote(id, { owner, loopback });
  return { ...answer, url: address(id) };
}

export async function videoRoute(context) {
  const { req, url, route, send, admin, device, browserSession, remote, engine, s, config, video } = context;
  const hub = config.role === "hub";
  const query = url.searchParams;
  const requireAdmin = () => {
    if (!admin) fail("Local administrator credential required", 403);
  };
  const requireDownloads = () => {
    requireAdmin();
    if (hub || !engine.videoDownloads) fail(DOWNLOADS_ONLY, 403);
    if (browserSession || !LOOPBACK.includes(remote)) fail("Use the local desktop application", 403);
  };
  if (MANAGED.includes(route)) {
    requireAdmin();
    if (!hub) fail(HUB_ONLY, 403);
  }
  if (req.method === "GET" || req.method === "HEAD") {
    if (route === "/v1/video/media") {
      if (!hub) requireAdmin();
      return streamVideo(context, query.get("volume"), query.get("path"), query.get("hash"));
    }
    if (route === "/v1/video/subtitles") {
      if (!hub) requireAdmin();
      if (query.get("format") === "json" && req.method === "HEAD") fail("Method not allowed", 405);
      return sendSubtitles(context, query.get("volume"), query.get("path"), query.get("format") === "json", embeddedQuery(query));
    }
    if (HLS.test(route)) {
      if (!hub) requireAdmin();
      const session = context.sessions.get(hlsSession(route));
      if (!session || session.owner !== ownerOf(context)) fail("Not found", 404);
      return serveHls(context, session, route);
    }
    if (req.method === "HEAD") fail("Method not allowed", 405);
    if (route === "/v1/video/compatible") {
      if (!hub) requireAdmin();
      return send(200, await compatible(context));
    }
    if (route === "/v1/video/library") {
      if (!hub) {
        requireAdmin();
        return send(200, await replicaLibrary(context, query.get("volume"), query.get("version")));
      }
      const library = video.library(query.get("volume"), query.get("version"));
      context.checkCredential();
      return send(200, library);
    }
    if (route === "/v1/video/art") {
      if (!hub) {
        requireAdmin();
        try {
          return send(200, await forward(engine, `${route}${url.search}`));
        } catch (error) {
          const data = error.status === 503 ? engine.videoDownloads?.artData(query.get("volume"), query.get("key"), query.get("size") === "large" ? "large" : "small") : null;
          if (!data) throw error;
          return send(200, { data });
        }
      }
      const art = await video.art(query.get("volume"), query.get("key"), query.get("size") === "large" ? "large" : "small");
      context.checkCredential();
      return send(200, art);
    }
    if (route === "/v1/video/playback") {
      requireAdmin();
      const volume = query.get("volume");
      const name = query.get("path");
      const hash = query.get("hash");
      if (typeof volume !== "string" || typeof name !== "string" || !/^[a-f0-9]{64}$/.test(hash || "")) fail("Invalid video");
      let item;
      if (hub) {
        video.media(volume, name, hash);
        item = video.entry(volume, name);
      } else {
        const listed = await replicaLibrary(context, volume, null);
        const local = engine.videoDownloads?.local(volume, name, hash);
        item = fileOf(listed, name) || local?.item;
        if (listed.offline && item && !local) fail(VIDEO_OFFLINE, 503);
      }
      if (!item || item.hash !== hash) fail("This video is no longer available", 404);
      const mediaQuery = new URLSearchParams({ volume, path: name, hash });
      const subtitles = item.subtitles.map((sub) => ({ path: sub.path, label: sub.label, language: sub.language }));
      if (browserSession)
        return send(200, {
          url: `/v1/video/media?${mediaQuery}`,
          subtitles: subtitles.map((sub) => ({ ...sub, url: `/v1/video/subtitles?${new URLSearchParams({ volume, path: sub.path })}` })),
        });
      if (!LOOPBACK.includes(remote)) fail("Use the local desktop application", 403);
      const media = issueVideoTicket(context.tickets, { route: "/v1/video/media", volume, name, hash, owner: config.adminToken });
      return send(200, { url: `http://127.0.0.1:${context.port()}/v1/video/media?ticket=${media}`, subtitles });
    }
    if (route === "/v1/video/downloads") {
      requireDownloads();
      return send(200, engine.videoDownloads.list(query.get("volume")));
    }
    if (route === "/v1/video/settings" || route === "/v1/video/tmdb-search" || route === "/v1/video/tmdb-image") {
      const value =
        route === "/v1/video/settings"
          ? video.settingsView()
          : route === "/v1/video/tmdb-search"
            ? await video.tmdbSearch(query.get("query"), query.get("type"), query.get("year"))
            : await video.tmdbImage(query.get("path"));
      context.checkCredential();
      return send(200, value);
    }
    fail("Endpoint not found", 404);
  }
  if (req.method !== "POST") fail("Method not allowed", 405);
  const body = await context.jsonBody();
  context.checkCredential();
  if (route === "/v1/video/mark") {
    requireAdmin();
    if (!hub) fail("This device is not the hub", 409);
    await context.authorizedWork(() => video.mark(body.volume));
    return send(200, { ok: true });
  }
  if (route === "/v1/video/position" || route === "/v1/video/watched") {
    if (!hub) {
      requireAdmin();
      return send(200, engine.videoDownloads ? await engine.videoDownloads.send(route, body) : await forward(engine, route, body));
    }
    const owner = admin ? { id: config.id, name: config.name } : { id: device.id, name: device.name };
    if (route === "/v1/video/position") return send(200, video.savePosition(owner, body));
    return send(200, video.setWatched(owner, body));
  }
  if (route === "/v1/video/watch-next/remove" || route === "/v1/video/watch-next/restore") {
    if (!hub) {
      requireAdmin();
      return send(200, await forward(engine, route, body));
    }
    return send(200, route.endsWith("/remove") ? video.hideWatchNext(body.volume, body.id) : video.restoreWatchNext(body.volume, body.id));
  }
  if (DOWNLOAD_ROUTES.includes(route)) {
    requireDownloads();
    if (route === "/v1/video/download") return send(200, await engine.videoDownloads.queue(body.volume, body.paths));
    if (route === "/v1/video/download/cancel") return send(200, engine.videoDownloads.cancel(body.volume, body.paths));
    return send(200, engine.videoDownloads.remove(body.volume, body.paths));
  }
  if (MANAGED.includes(route)) {
    if (route === "/v1/video/match") return send(200, video.match(body));
    if (route === "/v1/video/kids") return send(200, video.setKids(body));
    if (route === "/v1/video/refresh") return send(200, video.refresh());
    return send(200, video.saveSettings(body));
  }
  fail("Endpoint not found", 404);
}

export async function serveVideoTicket(context, pathname, ticket) {
  if (ticket.route !== pathname) fail("Playback access expired", 401);
  return streamVideo(context, ticket.volume, ticket.name, ticket.hash);
}
