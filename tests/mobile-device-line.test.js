import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deviceSegments, machineLabel, olderVersion, platformName, segmentText } from "../apps/mobile/src/device-line.js";

const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
const GB = 1024 ** 3;

test("a phone device line reads OS · folders · size and adds the version only when it is older than the hub's", () => {
  assert.deepEqual(deviceSegments({ platform: "android", version: "0.7.38", hubVersion: "0.7.38", folders: 6, size: 18 * GB }), [
    { parts: ["Android"] },
    { parts: ["6 folders", "18.0 GB"] },
  ]);
  assert.deepEqual(deviceSegments({ platform: "android", version: "0.7.35", hubVersion: "0.7.38", folders: 2, size: 3 * GB }), [
    { parts: ["Android"] },
    { parts: ["v0.7.35"], warning: true, label: "v0.7.35, older than the hub’s v0.7.38" },
    { parts: ["2 folders", "3.0 GB"] },
  ]);
  assert.deepEqual(deviceSegments({ platform: "ios" }), [{ parts: ["iOS"] }], "an unreported device leaves folders and size out, never 0");
  assert.deepEqual(deviceSegments({ platform: "darwin", folders: 1, size: 0 }), [{ parts: ["macOS"] }, { parts: ["1 folder", "0 B"] }]);
  assert.deepEqual(deviceSegments({ platform: "linux", version: "0.7.30" }), [{ parts: ["Linux"] }], "no hub version, no comparison");
  assert.equal(olderVersion("0.7.9", "0.7.10"), true, "numeric, not text, comparison");
  assert.equal(olderVersion("0.8.0", "0.7.38"), false);
  assert.equal(olderVersion("1.0.0", "1.0.0"), false);
  assert.equal(olderVersion(undefined, "1.0.0"), false);
  assert.equal(platformName("android"), "Android");
  assert.equal(platformName("ios"), "iOS");
  assert.equal(platformName("win32"), "Windows");
  assert.equal(platformName(""), "");
});

test("segments wrap only between each other, never inside one and never with a leading separator", () => {
  const [os, totals] = deviceSegments({ platform: "android", folders: 9, size: 412 * GB });
  assert.deepEqual(os.parts.map(segmentText), ["Android"]);
  assert.deepEqual(totals.parts.map(segmentText), ["9\u00a0folders", "412.0\u00a0GB"], "folders and size are separate parts that never break inside");
  const components = read("components.jsx");
  assert.match(components, /<View style=\{s\.deviceLine\}>\s+<View style=\{s\.deviceSegs\}>[\s\S]{0,120}<View key=\{segment\.parts\.join\(\)\} style=\{s\.deviceSeg\}>\s+\{segment\.parts\.map\(\(part\) => \(\s+<React\.Fragment key=\{part\}>\s+<Text style=\{\[s\.caption, s\.deviceSep\]\}>·<\/Text>/, "every part, folders and size included, carries the same separator box inside one unbreakable segment");
  assert.match(read("theme.js"), /deviceLine: \{ overflow: "hidden" \},\s+deviceSegs: \{ flexDirection: "row", flexWrap: "wrap", marginLeft: -12 \},\s+deviceSeg: \{ flexDirection: "row" \},\s+deviceSep: \{ width: 12, textAlign: "center" \},/, "a wrapped line's first separator sits in the clipped margin");
  assert.equal(
    machineLabel({ name: "umbrel", role: "Replica", backup: true, segments: deviceSegments({ platform: "android", version: "0.7.35", hubVersion: "0.7.38" }) }),
    "umbrel, Replica, Full backup, Android, v0.7.35, older than the hub’s v0.7.38",
  );
});

test("phone and Fold device rows end in their role chip after the row's action and show no Linked, sync or totals", () => {
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("export function MachineRow("), components.indexOf("export function SettingsGroup("));
  assert.match(row, /\{wide && !!state && <Badge>\{state\}<\/Badge>\}\s+\{actions\}\s+<RoleChip role=\{role\} hub=\{hub\} backup=\{backup\} \/>\s+<\/View>/, "Removed (Fold) and the action sit just before the chip");
  assert.doesNotMatch(row, /numberOfLines=\{1\} style=\{wide \? s\.mono|totals|machineEnd|BACKS UP|shownRole/);
  assert.match(row, /\{!!address && <Text style=\{s\.caption\}>\{address\}<\/Text>\}/, "the hub's address has its own line");
  assert.match(row, /segment\.warning && s\.stateWordWarning/);
  const chip = components.slice(components.indexOf("export function RoleChip("), components.indexOf("export function MachineRow("));
  assert.match(chip, /hub && s\.hubTag/);
  assert.match(chip, /backup && \(\s+<View accessible accessibilityLabel="Full backup"/);
  const theme = read("theme.js");
  assert.match(theme, /roleTagJoined: \{ borderTopRightRadius: 0, borderBottomRightRadius: 0 \}/);
  assert.match(theme, /backupTag: \{ borderLeftWidth: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 \}/);
  const app = read("App.jsx");
  const devices = app.slice(app.indexOf("<Text style={s.eyebrow}>DEVICES</Text>"), app.indexOf('{screen === "History" && ('));
  assert.doesNotMatch(devices, /"Linked"|"Up to date"|"Syncing"|totals=|lastAddress/);
  assert.match(devices, /hubVersion: machines\?\.find\(\(m\) => m\.isHub\)\?\.version/);
  assert.match(devices, /state=\{m\.revoked \? "Removed" : ""\}/);
  const hub = read("HubConnection.jsx");
  assert.match(hub, /folders: machine\?\.selectedFolders,\s+size: machine\?\.indexedBytes,/);
  assert.match(hub, /address=\{\[address\.host, connection\.leaving \? "Disconnection pending" : ""\]/);
  assert.match(read("runtime.js"), /version: Application\.nativeApplicationVersion \|\| config\.expo\.version,/, "the phone reports its app version");
  assert.match(read("icons.js"), /"shield-check": "ShieldCheck"/);
});
