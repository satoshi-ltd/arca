import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { brandColors, brandDrawing, brandDrawings } from "../packages/core/brand-mark.js";

const icons = path.join(import.meta.dirname, "..", "apps", "desktop", "src-tauri", "icons");
const rect = (r, attrs = "") =>
  `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.rx}"${attrs}/>`;
const glyph = (d, arch = brandColors.arch, door = brandColors.door) =>
  `<path d="${d.arch}" fill="${arch}"/>${rect(d.door, ` fill="${door}"`)}`;

function fullTile(size) {
  const d = brandDrawing(size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${d.viewBox}">${rect(d.tile, ` fill="${brandColors.tile}"`)}${glyph(d)}</svg>`;
}

function appleGrid(size) {
  if (size <= 16) return fullTile(size);
  const d = size < 128 ? brandDrawings.small : brandDrawings.display;
  const inset = Math.round(((1024 - 824) / 2048) * size);
  const body = size - inset * 2;
  const radius = (185.4 / 1024) * size;
  const scale = body / d.tile.width;
  const shadow = size >= 128;
  const blur = (20 / 1024) * size;
  const offset = (10 / 1024) * size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${
    shadow
      ? `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blur / 2}"/></filter></defs><rect x="${inset}" y="${inset + offset}" width="${body}" height="${body}" rx="${radius}" fill="#000" fill-opacity="0.3" filter="url(#s)"/>`
      : ""
  }<rect x="${inset}" y="${inset}" width="${body}" height="${body}" rx="${radius}" fill="${brandColors.tile}"/><g transform="translate(${inset} ${inset}) scale(${scale}) translate(${-d.tile.x} ${-d.tile.y})">${glyph(d)}</g></svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

const point = (x, y) => `${x} ${y}`;
const badgeMarks = {
  synced: [2, `M${point(31, 11)}L${point(34.5, 14.5)}L${point(41, 7)}`],
  paused: [2, `M${point(33.5, 7)}V15M${point(38.5, 7)}V15`],
  alert: [2.5, `M${point(36, 7)}V12M${point(36, 15.5)}V15.4`],
  syncing: [
    1.8,
    `M${point(40.505, 7.845)}A5.5 5.5 0 0 0 ${point(30.584, 10.045)}M${point(30.5, 7)}L${point(30.5, 10)}L${point(33.5, 10)}M${point(31.495, 14.155)}A5.5 5.5 0 0 0 ${point(41.416, 11.955)}M${point(41.5, 15)}L${point(41.5, 12)}L${point(38.5, 12)}`,
  ],
};

function tray(state) {
  const p = brandDrawings.pixel;
  const arch = `<g${state === "paused" ? ' opacity="0.45"' : ""}${state ? ' mask="url(#k)"' : ""}><g transform="translate(-7 -3) scale(3)"><path d="${p.arch}"/>${rect(p.door)}</g></g>`;
  const badge = state
    ? `<mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="36"><rect width="48" height="36" fill="#fff"/><circle cx="36" cy="11" r="12" fill="#000"/></mask><mask id="b" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="36"><rect width="48" height="36" fill="#fff"/><path d="${badgeMarks[state][1]}" fill="none" stroke="#000" stroke-width="${badgeMarks[state][0]}" stroke-linecap="round" stroke-linejoin="round"/></mask>`
    : "";
  const disc = state ? `<circle cx="36" cy="11" r="10" mask="url(#b)"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="36" viewBox="0 0 48 36"><defs>${badge}</defs>${arch}${disc}</svg>`;
}

if (process.platform !== "darwin") {
  console.error("desktop-icons.js needs macOS iconutil to write icon.icns");
  process.exit(1);
}
fs.writeFileSync(path.join(icons, "32x32.png"), await png(fullTile(32)));
fs.writeFileSync(path.join(icons, "128x128.png"), await png(fullTile(128)));
fs.writeFileSync(path.join(icons, "128x128@2x.png"), await png(fullTile(256)));
const icoEntries = [];
for (const size of [32, 16, 24, 48, 64, 256]) icoEntries.push({ size, data: await png(fullTile(size)) });
fs.writeFileSync(path.join(icons, "icon.ico"), ico(icoEntries));
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "arca-icons-")) + path.sep + "icon.iconset";
fs.mkdirSync(iconset);
for (const base of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    fs.writeFileSync(
      path.join(iconset, `icon_${base}x${base}${scale === 2 ? "@2x" : ""}.png`),
      await png(appleGrid(base * scale)),
    );
execFileSync("iconutil", ["-c", "icns", "-o", path.join(icons, "icon.icns"), iconset]);
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
for (const state of ["", "synced", "paused", "alert", "syncing"])
  fs.writeFileSync(path.join(icons, state ? `tray-${state}.png` : "tray.png"), await png(tray(state)));
