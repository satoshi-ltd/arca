import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brandColors, brandDrawings, brandSplashBox } from "../../../packages/core/brand-mark.js";

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const display = brandDrawings.display;
const pixel = brandDrawings.pixel;
const door = (d, fill) =>
  `<rect x="${d.door.x}" y="${d.door.y}" width="${d.door.width}" height="${d.door.height}" rx="${d.door.rx}" fill="${fill}"/>`;
const glyph = (d, arch, doorFill) => `<path d="${d.arch}" fill="${arch}"/>${door(d, doorFill)}`;
const archWidth = 240;
const archCentre = 251;

function launcher({ background, visible = 1, arch = brandColors.arch, doorFill = brandColors.door }) {
  const scale = (512 * visible * 0.5) / archWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${background ? `<rect width="512" height="512" fill="${background}"/>` : ""}<g transform="translate(256 ${512 * 0.49}) scale(${scale}) translate(-256 -${archCentre})">${glyph(display, arch, doorFill)}</g></svg>`;
}

function render(name, svg, size = 1024) {
  return fs.writeFileSync(`${assets}${name}.png`, execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size)], { input: svg }));
}

const androidVisible = 72 / 108;
render("icon", launcher({ background: brandColors.tile }));
render("icon-dark", launcher({}));
render("icon-tinted", launcher({ arch: "#ffffff", doorFill: "#bfbfbf" }));
render("adaptive-icon", launcher({ visible: androidVisible }));
render("monochrome-icon", launcher({ visible: androidVisible, arch: "#ffffff", doorFill: "#ffffff" }));
const splash = (arch) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${brandSplashBox}">${glyph(display, arch, brandColors.door)}</svg>`;
render("splash-icon-light", splash(brandColors.tile));
render("splash-icon-dark", splash(brandColors.arch));
render(
  "notification-icon",
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="${pixel.viewBox}">${glyph(pixel, "#ffffff", "#ffffff")}</svg>`,
  96,
);
