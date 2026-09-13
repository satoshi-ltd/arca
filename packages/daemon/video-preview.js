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
