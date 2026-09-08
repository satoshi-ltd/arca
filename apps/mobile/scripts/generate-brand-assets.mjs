// Rasterize the existing vector mark; do not flatten Android's adaptive layers.
// Requires librsvg (rsvg-convert). Run from any directory.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const original = fs.readFileSync(new URL('../../desktop/src/assets/arca-icon.svg', import.meta.url), 'utf8');
const mark = original.slice(original.indexOf('<path ')).replace('</svg>', '');
function render(name, { background, scale = 1, arch = '#eff5df', door = '#accb80', size = 1024 } = {}) {
  const shapes = mark.replace('#eff5df', arch).replace('#accb80', door);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${background ? `<rect width="512" height="512" fill="${background}"/>` : ''}<g transform="translate(256 256) scale(${scale}) translate(-256 -241)">${shapes}</g></svg>`;
  fs.writeFileSync(`${assets}${name}.png`, execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size)], { input: svg }));
}
render('icon', { background: '#244d3e', scale: 1.25 });
render('adaptive-icon', { scale: 0.85 });
render('monochrome-icon', { scale: 0.85, arch: '#ffffff', door: '#ffffff' });
render('splash-icon-light', { arch: '#244d3e' });
render('splash-icon-dark');
render('notification-icon', { arch: '#ffffff', door: '#ffffff', size: 96 });
