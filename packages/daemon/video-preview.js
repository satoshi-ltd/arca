import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import bundledFfmpeg from "ffmpeg-static";

const execute = promisify(execFile);
export async function videoPreview(file, name, large = false) {
  const size = large ? 2048 : 360;
  const binary =
    bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg";
  const { stdout } = await execute(
    binary,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-protocol_whitelist",
      "file",
      "-f",
      path.extname(name).toLowerCase() === ".webm" ? "matroska" : "mov",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-vf",
      `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
      "-threads",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ],
    {
      encoding: "buffer",
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 ** 2,
      windowsHide: true,
    },
  );
  if (!stdout.length) throw new Error("No video frame available");
  return stdout;
}

// Read container tags without decoding frames or transferring media to stdout.
export async function videoCaptureDate(file, name) {
  const binary =
    bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg";
  const { stdout } = await execute(
    binary,
    [
      "-v",
      "error",
      "-nostdin",
      "-protocol_whitelist",
      "file",
      "-f",
      path.extname(name).toLowerCase() === ".webm" ? "matroska" : "mov",
      "-i",
      file,
      "-map_metadata",
      "0",
      "-f",
      "ffmetadata",
      "pipe:1",
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  const tags = new Map(
    stdout.split(/\r?\n/).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1).replace(/\\(.)/g, "$1")];
    }),
  );
  for (const key of [
    "com.apple.quicktime.creationdate",
    "creation_time",
    "date",
  ]) {
    const raw = tags.get(key);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
        raw || "",
      )
    )
      continue;
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}
