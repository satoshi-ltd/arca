// Renders the store images in apps/mobile/store/index.html with headless Chrome at each
// store's exact pixel size, then flattens them (the stores refuse alpha channels).
//   node apps/mobile/store/render.mjs            every image into apps/mobile/store/out/
//   node apps/mobile/store/render.mjs <page> <WxH@scale> <out.png>   one ad hoc page
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { landscape } from "../../../deploy/review/seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../../..");
const out = path.join(here, "out");
const photos = path.join(here, "photos");
const chrome =
  process.env.CHROME ||
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  }[process.platform] ||
  "google-chrome";

// Each canvas is designed in CSS pixels and zoomed by `scale` to the store's exact size.
// Chrome lays a window out at least about 500 px wide, so the page renders at the final
// pixel size with a device scale of 1 and zooms the design (store.js) instead.
export const canvases = {
  // App Store Connect requires the medium Dynamic Island display (6.1"/6.3"); 6.9" is optional.
  "ios-phone": { css: [402, 874], scale: 3, dir: "app-store/iphone-6.3" },
  "ios-ipad": { css: [1032, 1376], scale: 2, dir: "app-store/ipad-13" },
  "play-phone": { css: [432, 768], scale: 2.5, dir: "google-play/phone" },
  "play-tablet": { css: [800, 1280], scale: 2, dir: "google-play/tablet" },
  "play-feature": { css: [512, 250], scale: 2, dir: "google-play", file: "feature-graphic" },
  // App Store product page creative assets: header (21:9) and search result (3:2).
  "ios-header": { css: [1920, 823], scale: 2, dir: "app-store/creative", file: "header" },
  "ios-search": { css: [1920, 1280], scale: 2, dir: "app-store/creative", file: "search-results" },
};
const slides = { phone: 6, tablet: 4 };
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".png": "image/png" };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(repository, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(repository + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Chrome on macOS writes the screenshot but may keep running, so wait for the file instead.
async function capture(args, raw) {
  const child = spawn(chrome, args, { stdio: "ignore" });
  const deadline = Date.now() + 60000;
  let last = -1;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const size = fs.existsSync(raw) ? fs.statSync(raw).size : -1;
      if (size > 0 && size === last) return;
      last = size;
      if (child.exitCode !== null && size <= 0) break;
    }
    throw new Error("Chrome did not write the screenshot");
  } finally {
    child.kill("SIGKILL");
  }
}

async function shoot(url, [width, height], scale, target) {
  const size = [Math.round(width * scale), Math.round(height * scale)];
  url += `${url.includes("?") ? "&" : "?"}w=${width}&h=${height}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "arca-store-"));
  const raw = `${target}.raw.png`;
  fs.rmSync(raw, { force: true });
  try {
    await capture([
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, "--force-device-scale-factor=1", `--window-size=${size[0]},${size[1]}`,
      "--virtual-time-budget=4000", `--screenshot=${raw}`, url,
    ], raw);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(profile, { recursive: true, force: true });
  }
  await sharp(raw).resize(size[0], size[1], { fit: "cover", position: "top" }).flatten({ background: "#f4f6f1" }).removeAlpha().png().toFile(target);
  fs.rmSync(raw);
  return size;
}

// The gallery tiles show the same generated landscapes as the store review hub.
async function paintPhotos() {
  const kinds = ["sunset", "beach", "forest", "dusk", "morning", "snow", "night", "desert"];
  fs.mkdirSync(photos, { recursive: true });
  for (let n = 1; n <= 36; n++) {
    const file = path.join(photos, `${String(n).padStart(2, "0")}.jpg`);
    if (fs.existsSync(file)) continue;
    const svg = landscape(kinds[(n * 5) % kinds.length], 640, 640, n * 7919);
    await sharp(Buffer.from(svg)).jpeg({ quality: 82, mozjpeg: true }).toFile(file);
  }
}

await paintPhotos();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const [page, spec, target] = process.argv.slice(2);
  if (page) {
    const [, w, h, s] = spec.match(/^(\d+)x(\d+)@([\d.]+)$/);
    console.log(target, await shoot(`${base}/${page}`, [+w, +h], +s, path.resolve(target)));
  } else {
    fs.rmSync(out, { recursive: true, force: true });
    for (const [name, canvas] of Object.entries(canvases)) {
      fs.mkdirSync(path.join(out, canvas.dir), { recursive: true });
      const count = canvas.file ? 1 : slides[/ipad|tablet/.test(name) ? "tablet" : "phone"];
      for (let slide = 1; slide <= count; slide++) {
        const file = canvas.file ? `${canvas.file}.png` : `${String(slide).padStart(2, "0")}.png`;
        const target = path.join(out, canvas.dir, file);
        const size = await shoot(`${base}/apps/mobile/store/index.html?canvas=${name}&slide=${slide}`, canvas.css, canvas.scale, target);
        console.log(path.relative(here, target), size.join("×"));
      }
    }
    const icon = path.join(out, "google-play", "icon-512.png");
    // Play wants the icon as a 32-bit PNG.
    await sharp(path.join(repository, "apps/mobile/assets/icon.png")).resize(512, 512).ensureAlpha().png().toFile(icon);
    console.log(path.relative(here, icon), "512×512");
  }
} finally {
  server.close();
}
