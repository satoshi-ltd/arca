import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import bundledFfmpeg from "ffmpeg-static";
import { fail } from "./storage.js";
import { extensionOf } from "../core/video-names.js";

export const BUSY = "The hub is busy with another video. Try again in a moment.";
const COPY_AUDIO = new Set(["aac", "mp3"]);
export const CLIENT_AUDIO = new Set(["ac3", "eac3", "flac", "alac", "opus"]);
const FILES = /^(index\.m3u8|init\.mp4|seg-\d{1,6}\.m4s)$/;
const execute = promisify(execFile);
const SEGMENT = /^seg-(\d{1,6})\.m4s$/;
const NICE = ["/usr/bin/nice", "/bin/nice"].find((file) => process.platform !== "win32" && fs.existsSync(file));

export const STREAMABLE_VIDEO = new Set(["h264", "hevc", "av1", "vp9"]);
const inputFormat = (source) => ["-f", { mkv: "matroska", webm: "matroska", avi: "avi" }[extensionOf(source)] || "mov"];

function audioArguments(codec, channels, copy) {
  if (COPY_AUDIO.has(codec) || copy.includes(codec)) return ["-c:a", "copy"];
  const count = Math.min(Math.max(Math.round(Number(channels)) || 2, 1), 6);
  return ["-c:a", "aac", "-ac", String(count), "-b:a", `${Math.min(count * 128, 640)}k`];
}

export function hlsArguments({ source, name = source, start, audio, videoCodec, audioCodec, audioChannels, copy = [], directory }) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "file",
    ...(start > 0 ? ["-noaccurate_seek", "-ss", String(start)] : []),
    ...inputFormat(name),
    "-i",
    source,
    "-map",
    "0:V:0",
    "-map",
    `0:a:${audio}?`,
    "-c:v",
    "copy",
    ...(videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []),
    ...audioArguments(audioCodec, audioChannels, copy),
    "-threads",
    "2",
    "-sn",
    "-dn",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    path.join(directory.replace(/%/g, "%%"), "seg-%d.m4s"),
    "-hls_flags",
    "independent_segments+temp_file",
    "-start_number",
    "0",
    path.join(directory, "index.m3u8"),
  ];
}

function size(directory) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(directory)) total += fs.statSync(path.join(directory, name), { throwIfNoEntry: false })?.size || 0;
  } catch {
    return 0;
  }
  return total;
}

export async function keyframeBefore(binary, source, start, signal, name = source) {
  if (!(start > 0)) return 0;
  try {
    const { stdout, stderr } = await execute(
      binary,
      ["-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-copyts", "-noaccurate_seek", "-ss", String(start), ...inputFormat(name), "-i", source, "-map", "0:V:0", "-c", "copy", "-frames:v", "1", "-f", "framecrc", "-"],
      { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, signal },
    );
    const base = /#tb 0: (\d+)\/(\d+)/.exec(stdout);
    const packet = stdout.split(/\r?\n/).find((line) => /^0,/.test(line));
    if (!base || !packet) return start;
    const origin = Number(/Duration: [^\n]*?start: (-?\d+(?:\.\d+)?)/.exec(stderr)?.[1]) || 0;
    const pts = Number(packet.split(",")[2]);
    const at = (pts * Number(base[1])) / Number(base[2]) - origin;
    return Number.isFinite(at) && at >= 0 && at <= start ? Math.floor(at * 1000) / 1000 : start;
  } catch {
    return start;
  }
}

export class VideoSessions {
  constructor(home, options = {}) {
    this.directory = path.join(home, "transcodes");
    this.binary = options.ffmpeg || (bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");
    this.limit = options.limit ?? 2;
    this.idleMs = options.idleMs ?? 60000;
    this.busyMs = options.busyMs ?? 30000;
    this.waitMs = options.waitMs ?? 30000;
    this.capBytes = options.capBytes ?? 4 * 1024 ** 3;
    this.ahead = options.aheadSegments ?? 30;
    this.behind = options.behindSegments ?? 100;
    this.aheadBytes = options.aheadBytes ?? 1024 ** 3;
    this.behindBytes = options.behindBytes ?? 1024 ** 3;
    this.sessions = new Map();
    this.sequences = new Map();
    try {
      fs.rmSync(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        return;
      }
    }, options.sweepMs ?? 10000);
    this.timer.unref?.();
  }
  close() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.end(id);
  }
  async halt() {
    this.sequences.clear();
    const stopped = [];
    for (const [id, session] of this.sessions) {
      const child = session.process;
      if (child?.pid && child.exitCode === null && child.signalCode === null)
        stopped.push(new Promise((resolve) => child.once("exit", resolve)));
      this.end(id);
    }
    await Promise.all(stopped);
  }
  next(owner) {
    const value = (this.sequences.get(owner) || 0) + 1;
    this.sequences.set(owner, value);
    return value;
  }
  current(owner, value) {
    return this.sequences.get(owner) === value;
  }
  get(id) {
    const session = typeof id === "string" ? this.sessions.get(id) : null;
    if (!session) return null;
    session.touched = Date.now();
    return session;
  }
  end(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const remove = () => {
      try {
        if (session.directory) fs.rmSync(session.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        return;
      }
    };
    const child = session.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.once("exit", remove);
      try {
        child.kill("SIGKILL");
      } catch {
        remove();
      }
    } else remove();
  }
  segments(session) {
    try {
      return fs
        .readdirSync(session.directory)
        .map((name) => SEGMENT.exec(name))
        .filter(Boolean)
        .map((match) => Number(match[1]));
    } catch {
      return [];
    }
  }
  segmentBytes(session, indexes) {
    let total = 0;
    for (const index of indexes)
      try {
        total += fs.statSync(path.join(session.directory, `seg-${index}.m4s`)).size;
      } catch {
        continue;
      }
    return total;
  }
  pace(session) {
    const child = session.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const segments = this.segments(session);
    const produced = Math.max(-1, ...segments);
    const watched = session.highest ?? -1;
    const aheadBytes = this.segmentBytes(session, segments.filter((index) => index > watched));
    const tooFar = produced - watched > this.ahead || aheadBytes > this.aheadBytes;
    try {
      if (process.platform === "win32") {
        if (aheadBytes > this.capBytes) child.kill("SIGKILL");
      } else if (!session.paused && tooFar) {
        child.kill("SIGSTOP");
        session.paused = true;
      } else if (session.paused && produced - watched <= this.ahead / 2 && aheadBytes <= this.aheadBytes / 2) {
        child.kill("SIGCONT");
        session.paused = false;
      }
    } catch {
      session.paused = false;
    }
  }
  prune(session) {
    if (!(session.highest >= 0)) return;
    let kept = 0;
    for (const index of this.segments(session)
      .filter((item) => item < session.highest)
      .sort((a, b) => b - a)) {
      kept += this.segmentBytes(session, [index]);
      if (index >= session.highest - this.behind && kept <= this.behindBytes) continue;
      try {
        fs.rmSync(path.join(session.directory, `seg-${index}.m4s`), { force: true });
        session.pruned = Math.max(session.pruned ?? -1, index);
      } catch {
        continue;
      }
    }
  }
  sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (!session.active && now - session.touched > this.idleMs) this.end(id);
    const local = [...this.sessions.values()].filter((session) => session.directory);
    for (const session of local) {
      this.pace(session);
      this.prune(session);
    }
    let total = local.reduce((sum, session) => sum + size(session.directory), 0);
    for (const session of local.filter((item) => !item.active && now - item.touched >= this.busyMs).sort((a, b) => a.touched - b.touched)) {
      if (total <= this.capBytes) break;
      total -= size(session.directory);
      this.end(session.id);
    }
  }
  room(owner) {
    for (const [id, session] of this.sessions) if (session.owner === owner) this.end(id);
    const running = [...this.sessions.values()];
    if (running.length < this.limit) return;
    const idle = running.filter((session) => Date.now() - session.touched >= this.busyMs).sort((a, b) => a.touched - b.touched)[0];
    if (!idle) fail(BUSY, 503);
    this.end(idle.id);
  }
  remote(id, { owner, loopback }) {
    if (!/^[a-f0-9]{32}$/.test(id || "")) fail("Invalid playback session", 502);
    for (const [known, session] of this.sessions) if (session.owner === owner) this.end(known);
    const session = { id, owner, loopback, remote: true, created: Date.now(), touched: Date.now() };
    this.sessions.set(id, session);
    return session;
  }
  start({ owner, loopback, source, name, start = 0, audio = 0, videoCodec, audioCodec, audioChannels, copy }) {
    this.sweep();
    this.room(owner);
    const id = crypto.randomBytes(16).toString("hex");
    const directory = path.join(this.directory, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const args = hlsArguments({ source, name, start, audio, videoCodec, audioCodec, audioChannels, copy, directory });
    const child = spawn(NICE || this.binary, NICE ? ["-n", "10", this.binary, ...args] : args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const session = { id, owner, loopback, directory, process: child, created: Date.now(), touched: Date.now(), error: "" };
    child.stderr.on("data", (chunk) => {
      if (session.error.length < 4096) session.error += chunk;
    });
    child.on("error", () => {
      session.failed = true;
    });
    child.on("exit", (code) => {
      session.exited = true;
      if (code) session.failed = true;
    });
    this.sessions.set(id, session);
    return session;
  }
  async file(session, name) {
    if (!FILES.test(name || "")) fail("Not found", 404);
    const file = path.join(session.directory, name);
    const ready = name === "init.mp4" ? path.join(session.directory, "index.m3u8") : file;
    const segment = SEGMENT.exec(name);
    if (segment) {
      if (Number(segment[1]) <= (session.pruned ?? -1) && !fs.existsSync(file)) fail("Not found", 404);
      session.highest = Math.max(session.highest ?? -1, Number(segment[1]));
      this.pace(session);
    }
    const deadline = Date.now() + this.waitMs;
    session.active = (session.active || 0) + 1;
    try {
      while (!fs.existsSync(ready) || !fs.existsSync(file)) {
        if (!this.sessions.has(session.id) || session.exited || Date.now() > deadline) {
          if (fs.existsSync(ready) && fs.existsSync(file)) break;
          fail(session.failed ? "This video could not be converted" : "Not found", session.failed ? 502 : 404);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      session.active--;
      session.touched = Date.now();
    }
    return {
      file,
      type: name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
    };
  }
}
