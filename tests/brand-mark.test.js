import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  brandColors,
  brandDraw,
  brandDrawing,
  brandDrawings,
  brandModule,
  brandTile,
} from "../packages/core/brand-mark.js";
import { brandMark } from "../apps/mobile/src/palette.js";
import { motion } from "../apps/mobile/src/design-tokens.js";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const bytes = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url));
const { display, small, pixel } = brandDrawings;
const doorAttrs = (door) =>
  `x="${door.x}" y="${door.y}" width="${door.width}" height="${door.height}"${door.rx ? ` rx="${door.rx}"` : ""}`;

test("the mark is built on one module and sits 1% above the tile's centre", () => {
  assert.equal(brandModule, 60);
  assert.deepEqual(brandTile, { x: 8, y: 8, width: 496, height: 496, rx: 116 });
  assert.equal(display.arch, "M136 380V242a120 120 0 0 1 240 0v138h-60V242a60 60 0 0 0-120 0v138z");
  assert.deepEqual(display.door, { x: 226, y: 284, width: brandModule, height: brandModule * 1.6, rx: 6 });
  const top = 242 - 2 * brandModule;
  const centre = (top + 380) / 2;
  assert.ok(Math.abs((256 - centre) / 512 - 0.01) < 0.001, "glyph 1% above the tile's centre");
  assert.equal(small.arch, "M136 380V242a120 120 0 0 1 240 0v138h-68V242a52 52 0 0 0-104 0v138z");
  assert.equal(pixel.arch, "M4 12V8a4 4 0 0 1 8 0v4h-2V8a2 2 0 0 0-4 0v4z");
  assert.deepEqual(brandColors, brandMark);
  for (const [name, colour] of Object.entries(brandColors))
    assert.match(read("apps/desktop/src/tokens.css"), new RegExp(`--mark-${name}: ${colour};`));
  assert.equal(brandDraw[0].startsWith("M166 380V242A90 90 0 0 1 256 152"), true, "draws from the left foot");
  assert.equal(brandDraw[1].startsWith("M346 380V242A90 90 0 0 0 256 152"), true, "and from the right foot");
});

test("each rendered size uses the drawing for its range", () => {
  assert.equal(brandDrawing(16), pixel);
  assert.equal(brandDrawing(23), pixel);
  assert.equal(brandDrawing(24), small);
  assert.equal(brandDrawing(32), small);
  assert.equal(brandDrawing(47), small);
  assert.equal(brandDrawing(48), display);
  assert.equal(brandDrawing(512), display);
  const icon = read("apps/desktop/src/assets/arca-icon.svg");
  assert.ok(icon.includes(`d="${display.arch}"`) && icon.includes(doorAttrs(display.door)), "arca-icon.svg is the display drawing");
  assert.doesNotMatch(icon, /metadata|c2pa/);
  const smallIcon = read("apps/desktop/src/assets/arca-icon-small.svg");
  assert.ok(smallIcon.includes(`d="${small.arch}"`) && smallIcon.includes(doorAttrs(small.door)), "arca-icon-small.svg is the small drawing");
  const html = read("apps/desktop/src/index.html");
  const sidebar = html.slice(html.indexOf('class="brand-mark"'), html.indexOf("</svg>", html.indexOf('class="brand-mark"')));
  assert.ok(sidebar.includes(`d="${small.arch}"`), "the 28 px sidebar mark uses the small drawing");
  assert.match(sidebar, /class="brand-door"\s+x="226"\s+y="280"\s+width="60"\s+height="100"\s+rx="4"/);
  assert.doesNotMatch(html, /brand-busy|brand-glyph|M136 370/);
  for (const file of ["apps/desktop/src/app.js", "apps/desktop/src/tray.js"])
    assert.ok(read(file).includes(`<path d="${display.arch}"/><rect ${doorAttrs(display.door)}/>`), `${file} draws the display arch as its placeholder`);
  assert.match(read("apps/desktop/src/tray.js"), /class="tray-brand-icon" src="assets\/arca-icon-small\.svg" width="28"/);
  assert.match(read("apps/desktop/src/app.js"), /<div class="brand"><img src="assets\/arca-icon-small\.svg" width="28" height="28" alt="Arca"><b>arca<\/b><\/div>/);
  const components = read("apps/mobile/src/components.jsx");
  assert.match(components, /export function Logo\(\{ size = 76, breathe = false \}\) \{\s+const drawing = brandDrawing\(size\);/);
  assert.match(components, /from "\.\.\/\.\.\/\.\.\/packages\/core\/brand-mark\.js";/);
  assert.doesNotMatch(components, /M136 370|glyph=\{/);
});

test("two lockups: compact 28/16/8 and display 48/28/12", () => {
  const tokens = read("apps/desktop/src/tokens.css");
  const style = read("apps/desktop/src/style.css");
  for (const [name, value] of Object.entries({
    "compact-mark": "28px",
    "compact-font": "16px",
    "compact-gap": "8px",
    "display-mark": "48px",
    "display-font": "28px",
    "display-gap": "12px",
  }))
    assert.match(tokens, new RegExp(`--lockup-${name}: ${value};`));
  assert.match(tokens, /--brand-mark-size: var\(--lockup-compact-mark\);/);
  assert.match(tokens, /--onboarding-brand: var\(--lockup-compact-font\);/);
  assert.match(tokens, /--access-mark: var\(--lockup-display-mark\);/);
  assert.match(tokens, /--access-brand-font: var\(--lockup-display-font\);/);
  assert.match(style, /\.brand \{[^}]*gap: var\(--lockup-compact-gap\);/);
  assert.match(style, /\.brand b \{\s+font-size: var\(--lockup-compact-font\);\s+font-weight: 700;\s+letter-spacing: -0\.03em;/);
  assert.match(style, /\.onboarding-rail \.brand \{\s+gap: var\(--lockup-compact-gap\);/);
  assert.match(style, /\.onboarding-rail \.brand img \{\s+width: var\(--lockup-compact-mark\);\s+height: var\(--lockup-compact-mark\);/);
  assert.match(style, /\.access-logo \{[^}]*gap: var\(--lockup-display-gap\);/);
  assert.match(style, /\.access-logo > svg \{\s+width: var\(--access-mark\);\s+height: var\(--access-mark\);/);
});

test("one motion: draw-in, then the door breathes; reduced motion holds the final mark", () => {
  const tokens = read("apps/desktop/src/tokens.css");
  const style = read("apps/desktop/src/style.css");
  const token = (name) => tokens.match(new RegExp(`--motion-${name}:\\s*([^;]+);`))[1].trim();
  assert.equal(token("draw"), "560ms");
  assert.equal(token("draw-door-delay"), "360ms");
  assert.equal(token("draw-door"), "240ms");
  assert.equal(token("draw-ease"), "cubic-bezier(0.45, 0, 0.2, 1)");
  assert.equal(token("door-rise"), "4%");
  assert.equal(token("loop"), `${motion.loop}ms`);
  assert.equal(token("breathe-low"), String(motion.breatheLow));
  for (const unused of ["draw", "drawDoorDelay", "drawDoor", "drawEase", "doorRise"])
    assert.equal(motion[unused], undefined, `the phone carries no ${unused} token it never reads`);
  const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const name of ["draw", "draw-door-delay", "draw-door"]) assert.match(reduced, new RegExp(`--motion-${name}: 0ms;`));
  assert.match(reduced, /--motion-breathe-low: 1;/);
  assert.match(tokens, /@keyframes brand-breathe \{[^}]*100% \{\s+opacity: 1;\s+\}\s+50% \{\s+opacity: var\(--motion-breathe-low\);/);
  assert.match(style, /\.brand-mark\.is-busy \.brand-door \{\s+animation-name: brand-breathe;\s+animation-duration: var\(--motion-loop\);/);
  assert.match(style, /\.launch-mark \.brand-draw-door \{\s+animation:\s+brand-door-in var\(--motion-draw-door\) var\(--motion-ease\) var\(--motion-draw-door-delay\) both,\s+brand-breathe var\(--motion-loop\)/);
  assert.match(style, /\.access-logo \.brand-draw-door \{\s+animation: brand-door-in [^;]+both;\s+\}/, "the sign-in tile draws once and never breathes");
  assert.match(style, /@media \(prefers-reduced-motion: reduce\) \{\s+\.brand-mark\.is-busy \.brand-door,\s+\.brand-draw-band,\s+\.brand-draw-door,\s+\.access-logo \.brand-draw-door,\s+\.launch-mark \.brand-draw-door \{\s+animation: none;/);
  const html = read("apps/desktop/src/index.html");
  assert.match(html, /<div class="launch-mark" role="status" aria-label="Starting Arca">/);
  assert.equal((html.match(/class="brand-draw-band"/g) || []).length, 2);
  const app = read("apps/desktop/src/app.js");
  assert.match(app, /await browserRequest\("\/auth\/login", \{ code \}\);[\s\S]{0,200}\$\("#content"\)\.innerHTML = launchMark\(\);/, "the web shows the launch arch after sign-in");
  assert.match(app, /<div class="access-logo">\$\{brandDraw\(true\)\}<h1>arca<\/h1><\/div>/);
  const motionSource = read("apps/mobile/src/motion.js");
  const breathe = motionSource.slice(motionSource.indexOf("export function useBreathe"), motionSource.indexOf("export function useMotion"));
  assert.match(breathe, /if \(!on \|\| reduce\) return;/);
  assert.match(breathe, /toValue: motion\.breatheLow, duration: half/);
  assert.match(breathe, /const half = motion\.loop \/ 2;/);
});

test("the busy mark keeps its drawing and breathes its door instead of the grid", () => {
  const app = read("apps/desktop/src/app.js");
  const activity = app.slice(app.indexOf("function updateBrandActivity()"), app.indexOf("const api ="));
  assert.doesNotMatch(activity, /busyIcon|brand-busy/);
  assert.match(activity, /mark\.setAttribute\("aria-label", visible \? "Arca: updating" : "Arca"\);/);
  const components = read("apps/mobile/src/components.jsx");
  const brand = components.slice(components.indexOf("export function BrandActivity()"), components.indexOf("const AnimatedPath"));
  assert.match(brand, /<Logo size=\{g\.screenTitleLogo\} breathe=\{!!active\} \/>/);
  assert.match(brand, /accessibilityLabel=\{active \? "Arca: updating" : undefined\}/);
  assert.doesNotMatch(brand, /<Busy/);
  const logo = components.slice(components.indexOf("export function Logo("), components.indexOf("export function BrandActivity()"));
  assert.match(logo, /const door = useBreathe\(breathe\);/);
  assert.match(logo, /<Animated\.View style=\{\[StyleSheet\.absoluteFill, \{ opacity: door \}\]\}>\s+<Svg width=\{size\} height=\{size\} viewBox=\{drawing\.viewBox\}>\s+<Rect \{\.\.\.drawing\.door\} fill=\{brandMark\.door\} \/>/);
});

test("desktop placeholders and content empty states draw the arch; video, artists and errors keep glyphs", () => {
  const app = read("apps/desktop/src/app.js");
  const helpers = app.slice(app.indexOf("const brandArch = () =>"), app.indexOf("const busyIcon = () =>"));
  const pick = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const source = [
    helpers,
    pick("function empty(", "\n}\n") + "\n}",
    pick("function musicCover(", "\n}\n") + "\n}",
    pick("function scaffoldLine(", "\n}\n") + "\n}",
    pick("function scaffoldRow(", "\n}\n") + "\n}",
  ].join("\n");
  const context = vm.createContext({
    icon: (name) => `<span data-icon="${name}"></span>`,
    escape: (value) => String(value),
    URLSearchParams,
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  assert.match(run('musicCover("v", "k")'), /class="music-cover" data-music-cover="[^"]+"><svg class="brand-arch"/);
  assert.match(run('musicCover("v", null, "arca", " large")'), /class="music-cover large"><svg class="brand-arch"/);
  assert.match(run('musicCover("v", null, "mic-vocal")'), /data-icon="mic-vocal"/);
  assert.match(run('musicCover("v", null, "list-music")'), /data-icon="list-music"/);
  assert.match(run('empty("This folder is empty", "", "", "arca")'), /^<div class="empty"><svg class="brand-arch"/);
  assert.match(run('empty("Content unavailable", "Try again.")'), /data-icon="folder-open"/);
  assert.match(run('scaffoldRow()'), /<span class="scaffold-mark" aria-hidden="true"><svg class="brand-arch"/);
  assert.match(run('scaffoldRow("history")'), /<span class="scaffold-mark" aria-hidden="true"><\/span>/);
  assert.match(app, /\$\{item\.kind === "video" \? icon\("play"\) : brandArch\(\)\}<\/button>/);
  assert.doesNotMatch(app, /musicCover\([^)]*"(disc-3|podcast|music)"/);
  assert.match(app, /empty\("This folder is empty", "", "", "arca"\)/);
  for (const title of ["No photos yet", "No music yet", "Reading this library"])
    assert.match(app, new RegExp(`empty\\(\\s*"${title}",\\s*"[^"]+",\\s*"",\\s*"arca",?\\s*\\)`), title);
  const style = read("apps/desktop/src/style.css");
  assert.match(style, /\.empty > \.brand-arch > path \{\s+fill: var\(--line\);/);
  assert.match(style, /\.empty > \.brand-arch > rect \{\s+fill: var\(--green\);/);
  assert.match(style, /\.photo-open \{[^}]*background: var\(--placeholder\);\s+color: var\(--line\);/);
  assert.match(style, /\.music-cover \{[^}]*background: var\(--placeholder\);\s+color: var\(--line\);/);
});

test("phone placeholders, covers without art and content empty states draw the arch", () => {
  const components = read("apps/mobile/src/components.jsx");
  const library = read("apps/mobile/src/MusicLibrary.jsx");
  const cover = library.slice(library.indexOf("export function Cover("), library.indexOf("function MusicRow("));
  assert.match(cover, /icon === "album" \|\| icon === "podcast" \? \(/);
  assert.match(cover, /<BrandArch size=\{Math\.round\(size \* 0\.34\)\} band=\{c\.line\} \/>/);
  assert.match(cover, /<View style=\{s\.coverMark\}>\s+<BrandArch size="100%" band=\{c\.line\} \/>/);
  assert.match(read("apps/mobile/src/theme.js"), /coverMark: \{ width: "34%", aspectRatio: 1 \},/);
  const arch = components.slice(components.indexOf("export function BrandArch("), components.indexOf("export function MediaPlaceholder("));
  assert.match(arch, /<Svg width=\{size\} height=\{size\} viewBox=\{brandGlyphBox\} style=\{style\}>\s+<Path d=\{glyph\.arch\} fill=\{band\} \/>\s+<Rect \{\.\.\.glyph\.door\} fill=\{door \|\| band\} \/>/);
  assert.match(read("apps/mobile/src/history-empty.js"), /icon: "arca",\s+title: "No history yet",/);
  assert.match(read("apps/mobile/src/MusicLibrary.jsx"), /icon="arca"\s+title="No music on this phone yet"/);
  assert.match(read("apps/mobile/src/MusicLibrary.jsx"), /icon="arca"\s+title="Loading the library"/);
});

test("the phone holds the splash mark in place, and iOS draws the arch with the pull", () => {
  const app = read("apps/mobile/src/App.jsx");
  const components = read("apps/mobile/src/components.jsx");
  assert.match(app, /if \(opening\)\s+return \([\s\S]{0,600}<LaunchHold \/>/);
  assert.doesNotMatch(app, /<Scaffold label="Opening Arca" \/>/);
  assert.match(app, /\{launchShown && <LaunchHold leaving onLeft=\{\(\) => setLaunchShown\(false\)\} \/>\}\s+<\/Design\.Provider>/);
  const hold = components.slice(components.indexOf("export function LaunchHold("), components.indexOf("export function Section("));
  assert.match(hold, /<View style=\{\{ width: 160, height: 160 \}\}>/, "the splash's 160 dp canvas");
  assert.match(hold, /viewBox=\{brandSplashBox\}/);
  assert.match(hold, /duration: exit/);
  assert.match(hold, /opacity: reduce \? 1 : door/);
  assert.match(app, /tintColor=\{Platform\.OS === "ios" \? "transparent" : c\.accent\}/);
  assert.match(app, /<PullArch pull=\{pull\} refreshing=\{pulling\} \/>/);
  assert.match(app, /const pullSync = screen === "Folders" && !folder && connected && !!replica;/);
  assert.match(app, /refreshControl=\{\s+pullSync \? \(/, "the refresh control mounts only when a pull can sync");
  assert.match(app, /\{Platform\.OS === "ios" && pullSync && \(\s+<Animated\.View/, "and the iOS arch shows only with it");
  assert.match(hold, /accessible=\{!leaving\}\s+importantForAccessibility=\{leaving \? "no-hide-descendants" : "auto"\}/, "the fading splash leaves the accessibility tree");
  const pull = components.slice(components.indexOf("export function PullArch("), components.indexOf("export function LaunchHold("));
  assert.match(pull, /progress=\{refreshing \? full : pull\}/);
  assert.match(pull, /door=\{refreshing \? breathing : lit\}/);
  assert.match(pull, /inputRange: \[0, 0\.999, 1\],\s+outputRange: \[0, 0, 1\],/, "the door lights only at the threshold");
});

test("the desktop icon generator picks drawings through the shared brandDrawing", () => {
  const script = read("scripts/desktop-icons.js");
  assert.match(script, /import \{ brandColors, brandDrawing, brandDrawings \} from "\.\.\/packages\/core\/brand-mark\.js";/);
  assert.match(script, /function fullTile\(size\) \{\s+const d = brandDrawing\(size\);/);
  assert.doesNotMatch(script, /drawingFor/);
  assert.doesNotMatch(read("SPEC.md"), /favicons at 16/);
});

test("the desktop window opens on the paper colour", () => {
  const config = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
  const paper = read("apps/desktop/src/tokens.css").match(/--paper: (#[0-9a-f]{6});/i)[1];
  assert.equal(config.app.windows[0].backgroundColor.toLowerCase(), paper.toLowerCase());
});

const png = (file) => {
  const data = bytes(file);
  assert.equal(data.toString("ascii", 12, 16), "IHDR", file);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), alpha: [4, 6].includes(data[25]) };
};

test("regenerated icons keep their names and dimensions", () => {
  const desktop = "apps/desktop/src-tauri/icons/";
  for (const [file, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256]])
    assert.deepEqual(png(desktop + file), { width: size, height: size, alpha: true }, file);
  for (const state of ["", "-synced", "-paused", "-alert", "-syncing"])
    assert.deepEqual(png(`${desktop}tray${state}.png`), { width: 48, height: 36, alpha: true }, state);
  const ico = bytes(desktop + "icon.ico");
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => ico[6 + 16 * i] || 256);
  assert.deepEqual(sizes, [32, 16, 24, 48, 64, 256]);
  const icns = bytes(desktop + "icon.icns");
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  const types = [];
  for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) types.push(icns.toString("ascii", at, at + 4));
  for (const type of ["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) assert.ok(types.includes(type), type);
  const tauri = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
  for (const icon of tauri.bundle.icon) assert.ok(fs.existsSync(new URL(`../apps/desktop/src-tauri/${icon}`, import.meta.url)), icon);
  const mobile = "apps/mobile/assets/";
  assert.deepEqual(png(mobile + "icon.png"), { width: 1024, height: 1024, alpha: false }, "iOS rejects an icon with alpha");
  for (const file of ["adaptive-icon.png", "monochrome-icon.png", "splash-icon-light.png", "splash-icon-dark.png", "icon-dark.png", "icon-tinted.png"])
    assert.deepEqual(png(mobile + file), { width: 1024, height: 1024, alpha: true }, file);
  assert.deepEqual(png(mobile + "notification-icon.png"), { width: 96, height: 96, alpha: true });
  const expo = JSON.parse(read("apps/mobile/app.json")).expo;
  assert.deepEqual(expo.ios.icon, {
    light: "./assets/icon.png",
    dark: "./assets/icon-dark.png",
    tinted: "./assets/icon-tinted.png",
  });
  const splash = expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen")[1];
  assert.equal(splash.imageWidth, 160);
  for (const file of [expo.icon, expo.android.adaptiveIcon.foregroundImage, expo.android.adaptiveIcon.monochromeImage, splash.image, splash.dark.image])
    assert.ok(fs.existsSync(new URL(`../apps/mobile/${file}`, import.meta.url)), file);
});
