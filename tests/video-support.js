import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import { init, digest } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

const clips = new Map();
const clipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-clips-"));
process.on("exit", () => fs.rmSync(clipRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

export function clip({ seconds = 1, size = "320x240", container = "mp4", tone = 440 } = {}) {
  const key = JSON.stringify([seconds, size, container, tone]);
  if (!clips.has(key)) {
    const output = path.join(clipRoot, `${clips.size}.${container}`);
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=5`,
      "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${seconds}`,
      "-c:v", "mpeg4", "-c:a", container === "webm" ? "libopus" : "aac", "-shortest",
      ...(container === "webm" ? ["-c:v", "libvpx"] : []),
      output,
    ]);
    clips.set(key, fs.readFileSync(output));
  }
  return clips.get(key);
}

export const image = (color, width = 600, height = 900) =>
  sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();

export function api(port, token) {
  return async function call(route, body, as = token, extra = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${as}`,
        "Content-Type": "application/json",
        "X-Arca-Directories": "1",
        "X-Arca-Path-Transitions": "1",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, body: value });
    return value;
  };
}

export async function hub(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-"));
  init(home, { port: 0, name: "Video hub" });
  const daemon = await start(home, { timer: false, ...options });
  t.after(async () => {
    await daemon.engine.video?.background;
    await daemon.engine.video?.matcher;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const s = daemon.engine.store;
  const v = s.addVolume("Videos");
  const call = api(daemon.port, daemon.engine.config.adminToken);
  async function propose(name, buffer, volume = v.id) {
    const hash = digest(buffer);
    if (!fs.existsSync(s.blob(hash))) fs.writeFileSync(s.blob(hash), buffer);
    await call("/v1/propose", { volume, path: name, hash, size: buffer.length, base: s.current(volume, name)?.rev || 0 });
    return hash;
  }
  const library = (query = "", as) => call(`/v1/video/library?volume=${v.id}${query}`, undefined, as);
  async function settled(as) {
    for (let i = 0; i < 200; i++) {
      await daemon.engine.video?.background;
      await daemon.engine.video?.matcher;
      const value = await library("", as);
      if (!value.indexing && !value.matching) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Video library did not settle");
  }
  return { home, daemon, s, v, call, propose, library, settled };
}

export function tmdbServer(catalog = {}) {
  const calls = [];
  const state = { status: null };
  async function fetchImpl(href, options = {}) {
    const url = new URL(href);
    calls.push({ url, headers: options.headers || {} });
    if (state.status) return new Response("{}", { status: state.status, headers: state.headers || {} });
    if (url.hostname === "image.tmdb.org") {
      const color = catalog.images?.[url.pathname.split("/").pop()] || "orange";
      return new Response(await image(color, 780, 1170), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    const route = url.pathname.replace(/^\/3/, "");
    const query = url.searchParams.get("query")?.toLowerCase();
    let body;
    if (route === "/search/movie") body = { results: catalog.searchMovie?.[query] || [] };
    else if (route === "/search/tv") body = { results: catalog.searchTv?.[query] || [] };
    else if (/^\/movie\/\d+$/.test(route)) body = catalog.movies?.[route.split("/")[2]];
    else if (/^\/tv\/\d+$/.test(route)) body = catalog.tv?.[route.split("/")[2]];
    else if (route === "/configuration/primary_translations") body = catalog.primaryTranslations;
    else if (route === "/certification/movie/list") body = catalog.certifications?.movie && { certifications: catalog.certifications.movie };
    else if (route === "/certification/tv/list") body = catalog.certifications?.tv && { certifications: catalog.certifications.tv };
    else if (/^\/tv\/\d+\/season\/\d+$/.test(route)) body = catalog.seasons?.[`${route.split("/")[2]}:${route.split("/")[4]}`];
    if (!body) return new Response(JSON.stringify({ status_message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return { fetch: fetchImpl, calls, state };
}
