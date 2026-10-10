import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iconNames } from "../apps/mobile/src/icons.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "mobile", "src");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const theme = read("theme.js");
const rule = (key) => theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1];

test("covered and two-line music rows take the 74 row height, numbered album rows stay one line at 48", () => {
  assert.match(rule("musicTrackTall"), /minHeight: g\.rowMinHeight/);
  assert.match(rule("musicTrack"), /minHeight: g\.rowMinHeightCompact/);
  const library = read("MusicLibrary.jsx");
  assert.match(library, /const style = \[s\.musicTrack, !compact && s\.musicTrackTall, index > 0 && s\.separator\];/);
  assert.match(library, /compact=\{!episodes && !withAlbum\}/, "only an album's numbered rows are one line");
  assert.match(library, /<Cover uri=\{cover\} size=\{40\} icon=\{icon\} \/>/, "list covers are 40 like every leading tile");
  assert.match(read("NowPlayingPage.jsx"), /style=\{\(\{ pressed \}\) => \[s\.musicTrack, s\.musicTrackTall, current && s\.historyRowChosen/, "Up next rows are 74");
});

test("Folders and Devices are grouped surfaces: sections for folders, one list with the hub first for devices", () => {
  const app = read("App.jsx");
  const folders = app.slice(app.indexOf("folderSections(folderRows"), app.indexOf("ON HUB · NOT SELECTED"));
  assert.match(folders, /<View style=\{s\.group\}>\s+\{section\.folders\.map\(\(f, index\) =>/);
  assert.match(folders, /<FolderRow\s+grouped\s+divider=\{index > 0\}/);
  assert.match(app, /<View style=\{s\.availableGroup\}>[\s\S]*?<FolderRow\s+key=\{v\.id\}\s+grouped\s+dashedDivider=\{index > 0\}/);
  const devices = app.slice(app.indexOf('<Text style={s.eyebrow}>DEVICES</Text>'), app.indexOf('{screen === "History" && ('));
  assert.ok(devices.indexOf("<HubConnection") < devices.indexOf("self"), "the hub comes first, then this device");
  assert.match(devices, /<View style=\{s\.group\}>\s+<HubConnection\s+grouped/);
  assert.equal((devices.match(/<MachineRow\s+(key=\{m\.credentialId\}\s+)?grouped\s+divider/g) || []).length, 2);
  const devicesScreen = app.slice(app.indexOf('{screen === "Devices" && ('), app.indexOf('{screen === "History" && ('));
  assert.doesNotMatch(devicesScreen, /HUB CONNECTION/, "the hub is no longer a card apart");
  const components = read("components.jsx");
  assert.match(components, /style=\{\[s\.card, s\.machineRow, grouped && s\.groupedMachineRow, divider && s\.separator\]\}/);
  assert.match(rule("groupedMachineRow"), /borderRadius: 0, borderWidth: 0/);
  assert.match(rule("machineRow"), /justifyContent: "center"/);
  assert.match(read("HubConnection.jsx"), /<MachineRow\s+grouped=\{grouped\}/);
});

test("settings rows centre their content at 48, grow to 74 with a hint, and controls meet the 16 dp edge", () => {
  assert.match(rule("settingRow"), /minHeight: g\.rowMinHeightCompact,\s+justifyContent: "center",/);
  assert.match(rule("settingRowTall"), /minHeight: g\.rowMinHeight/);
  assert.match(rule("settingWithActions"), /gap: 12/, "segmented controls sit 12 below their hint");
  assert.match(rule("switchTarget"), /alignItems: "flex-end"/, "the switch sits on the row's right padding");
  assert.match(rule("actionRow"), /gap: 12/, "sheet rows keep the 12 gap after the icon");
  const components = read("components.jsx");
  assert.match(components, /const tall =\s+grouped &&\s+\(title \? content\.length > 0 : content\.some\(\(child\) => !!child\?\.props\?\.description\)\);/);
  assert.match(components, /tall && s\.settingRowTall,/);
});

test("music presses share the .98 scale, album tiles dim to 85 % and the playing glyph cross-fades", () => {
  const library = read("MusicLibrary.jsx");
  assert.match(library, /import \{[^}]*\bPressScale,[^}]*\} from "\.\/components";/);
  assert.match(read("components.jsx"), /export function PressScale\(/);
  assert.match(library, /<PressScale[\s\S]{0,900}?style=\{\(\{ pressed \}\) => \[\.\.\.style, pressed && s\.pressed\]\}/, "track rows");
  assert.match(library, /<PressScale[\s\S]{0,900}?style=\{\(\{ pressed \}\) => \[s\.miniPlayer, pressed && s\.pressed\]\}/, "mini player");
  assert.match(library, /style=\{\(\{ pressed \}\) => \[s\.musicAlbum, pressed && s\.musicTilePressed\]\}/, "album tiles");
  assert.match(rule("musicTilePressed"), /opacity: 0\.85/);
  assert.match(library, /<ChangeFade token=\{playing \? "playing" : "paused"\} ms=\{motion\.fast\} style=\{s\.musicGlyph\}>\s+<Icon name=\{playing \? "audio-lines" : "music"\}/);
  assert.match(library, /<ChangeFade token=\{playing \? "pause" : "play"\} ms=\{motion\.fast\}>/, "the mini player's play and pause cross-fade");
  assert.match(library, /<ChangeFade token=\{pane\.level === 0 \? top\.kind : `page:\$\{pane\.level\}`\} ms=\{motion\.fast\}/, "Library tabs cross-fade in 120 ms");
  for (const name of ["moon", "audio-lines", "podcast", "rotate-ccw", "rotate-cw"]) assert.ok(iconNames[name], name);
});

test("the mini player and resume card rise once per session, and covers fly into the header on the Fold", () => {
  const motionSource = read("motion.js");
  const rise = motionSource.slice(motionSource.indexOf("export function RiseOnce"));
  assert.match(rise, /const first = useRef\(!seen\.current && !reduce\)\.current;/, "reduced motion and later appearances are instant");
  assert.match(rise, /duration: duration\(motion\.enter\),[\s\S]*?useNativeDriver: true/);
  assert.match(rise, /outputRange: \[motion\.distance, 0\]/);
  assert.doesNotMatch(rise, /height|width|top:|left:/);
  assert.match(motionSource, /export function ChangeFade\(\{ token, children, style, ms = motion\.enter \}\)/);
  const library = read("MusicLibrary.jsx");
  assert.match(library, /const miniSeen = \{ current: false \};/);
  assert.match(library, /<RiseOnce seen=\{miniSeen\}>/);
  assert.match(library, /<RiseOnce seen=\{resumeSeen\}>/);
  assert.match(library, /const flight = useFlight\("collection", true\);/);
  assert.equal((library.match(/putFlight\("collection"/g) || []).length, 2, "show and album tiles hand the cover over");
  assert.match(library, /wide && !split && art\.current\?\.measureInWindow/, "only the Fold root flies; the split keeps its pane");
  assert.match(read("NowPlayingPage.jsx"), /<ChangeFade token=\{current \? track\.id : "row"\} ms=\{motion\.fast\}>/, "the Up next highlight follows the track in 120 ms");
});

test("a numbered album row with its actions button stays at the compact 48 height", async () => {
  const { geometry } = await import("../apps/mobile/src/design-tokens.js");
  assert.match(rule("musicTrack"), /paddingVertical: \(g\.rowMinHeightCompact - g\.touchHeight\) \/ 2,/);
  assert.match(rule("musicRowAction"), /height: g\.touchHeight,/);
  assert.equal(geometry.touchHeight + 2 * ((geometry.rowMinHeightCompact - geometry.touchHeight) / 2), geometry.rowMinHeightCompact);
  assert.match(rule("musicTrackTall"), /paddingVertical: g\.rowPaddingY/);
});

test("folder names stay on one line and the sleep timer chip keeps the header's right inset", () => {
  assert.match(read("components.jsx"), /<Text style=\{s\.rowTitle\} numberOfLines=\{1\}>\{name\}<\/Text>/);
  assert.match(rule("sleepChip"), /marginRight: 8,/);
});
