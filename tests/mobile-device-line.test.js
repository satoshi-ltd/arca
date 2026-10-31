import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deviceCells, deviceSegments, foldRowFits, machineLabel, olderVersion, platformName, presence, rosterPresence, segmentText } from "../apps/mobile/src/device-line.js";

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
    machineLabel({ name: "nas", role: "Replica", backup: true, segments: deviceSegments({ platform: "android", version: "0.7.35", hubVersion: "0.7.38" }) }),
    "nas, Replica, Full backup, Android, v0.7.35, older than the hub’s v0.7.38",
  );
});

test("phone and Fold device rows end in their role chip after the row's action and show no Linked or sync state", () => {
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("function DeviceLine("), components.indexOf("export function SettingsGroup("));
  assert.match(row, /<View style=\{s\.machineEnd\}>\s+\{!!state && <Badge>\{state\}<\/Badge>\}\s+\{actions\}\s+\{chip\}\s+<\/View>/, "on the Fold, Removed and the action sit just before the chip at the right edge");
  assert.match(row, /<View style=\{s\.machineHead\}>\s+\{identity\}\s+<View style=\{s\.machineEnd\}>\s+\{!!actions && <View style=\{s\.machineHeadAction\}>\{actions\}<\/View>\}\s+\{chip\}/, "on the phone the action and the chip sit on the name line");
  assert.doesNotMatch(row, /numberOfLines=\{1\} style=\{wide \? s\.mono|BACKS UP|shownRole/);
  assert.match(row, /\{!!address && <Text style=\{s\.caption\}>\{address\}<\/Text>\}/, "the hub's address has its own line");
  assert.match(row, /segment\.warning && s\.stateWordWarning/);
  const chip = components.slice(components.indexOf("export function RoleChip("), components.indexOf("export function MachineRow("));
  assert.match(chip, /hub && s\.hubTag/);
  assert.match(chip, /backup && \(\s+<View accessible accessibilityLabel="Full backup"/);
  const theme = read("theme.js");
  assert.match(theme, /roleTagJoined: \{ borderTopRightRadius: 0, borderBottomRightRadius: 0 \}/);
  assert.match(theme, /backupTag: \{ borderLeftWidth: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 \}/);
  const app = read("App.jsx");
  const devices = app.slice(app.indexOf("<Eyebrow>Devices</Eyebrow>"), app.indexOf('{screen === "History" && ('));
  assert.doesNotMatch(devices, /"Linked"|"Up to date"|"Syncing"|totals=|lastAddress/);
  assert.match(devices, /hubVersion: machines\?\.find\(\(m\) => m\.isHub\)\?\.version/);
  assert.match(devices, /state=\{m\.revoked \? "Removed" : ""\}/);
  const hub = read("HubConnection.jsx");
  assert.match(hub, /folders: machine\?\.selectedFolders,\s+size: machine\?\.indexedBytes,/);
  assert.match(hub, /address=\{\[address\.host, connection\.leaving \? "Disconnection pending" : ""\]/);
  assert.match(read("runtime.js"), /version: Application\.nativeApplicationVersion \|\| config\.expo\.version,/, "the phone reports its app version");
  assert.match(read("icons.js"), /"shield-check": "ShieldCheck"/);
});

const clock = Date.parse("2026-10-11T09:40:00.000Z");
const at = (seconds) => new Date(clock - seconds * 1000).toISOString();
const seenAt = (value) => `Seen ${new Date(value).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;

test("presence reads Connected within two minutes of the hub's clock, otherwise when the device was last seen", () => {
  assert.deepEqual(presence({ self: true }), { connected: true, label: "Connected" }, "this device is always Connected");
  assert.deepEqual(presence({ seen: [at(119)], now: clock }), { connected: true, label: "Connected" });
  assert.deepEqual(presence({ seen: [at(120)], now: clock }), { connected: false, label: seenAt(at(120)) });
  assert.deepEqual(presence({ seen: [at(4000), at(30), null], now: clock }), { connected: true, label: "Connected" }, "the freshest of last contact and report decides");
  assert.deepEqual(presence({ seen: [at(5)], now: clock, offline: true }), { connected: false, label: seenAt(at(5)) }, "saved or offline information never reads Connected");
  assert.equal(presence({ seen: [null, undefined, "not a date"], now: clock }), null, "no contact leaves the cell out");
});

test("the roster's presence takes the hub's report time as now and the phone's own last contact for the hub row", () => {
  const machines = [
    { isHub: true, reportedAt: at(200) },
    { credentialId: "me", lastContact: at(10) },
    { credentialId: "yuri", lastContact: at(90), reportedAt: at(500) },
    { credentialId: "tablet", lastContact: at(3600) },
    { credentialId: "invited" },
    { credentialId: "removed", revoked: true, lastContact: at(20) },
  ];
  const online = rosterPresence(machines, { connectionId: "me" });
  assert.deepEqual(online.hub, { connected: true, label: "Connected" });
  assert.deepEqual(online.of(machines[2]), { connected: true, label: "Connected" }, "skew-free: compared with the hub's own clock");
  assert.deepEqual(online.of(machines[3]), { connected: false, label: seenAt(at(3600)) });
  assert.equal(online.of(machines[4]), null);
  assert.deepEqual(online.of(machines[5]), { connected: false, label: seenAt(at(20)) }, "a removed device never reads Connected");
  const saved = rosterPresence(machines, { connectionId: "me", offline: true });
  assert.deepEqual(saved.hub, { connected: false, label: seenAt(at(10)) }, "offline, the hub row says when this phone last reached it");
  assert.deepEqual(saved.of(machines[2]), { connected: false, label: seenAt(at(90)) });
  assert.equal(rosterPresence(null).hub, null);
});

test("Fold cells always show the version, flag an older one unless removed, and leave unreported totals out", () => {
  assert.deepEqual(deviceCells({ version: "0.7.39", hubVersion: "0.7.39", folders: 9, size: 412 * GB }), {
    version: { text: "v0.7.39", older: false, label: "v0.7.39" },
    totals: ["9 folders", "412.0 GB"],
  });
  assert.deepEqual(deviceCells({ version: "0.7.35", hubVersion: "0.7.39", folders: 1, size: GB }).version, {
    text: "v0.7.35",
    older: true,
    label: "v0.7.35, older than the hub’s v0.7.39",
  });
  assert.equal(deviceCells({ version: "0.7.30", hubVersion: "0.7.39", revoked: true }).version.older, false, "a removed device never shows the up-arrow");
  assert.deepEqual(deviceCells({}), { version: null, totals: null }, "never 0 or a placeholder");
  assert.deepEqual(deviceCells({ version: "0.7.39-beta.12+build.2026", hubVersion: "0.7.39" }).version, {
    text: "v0.7.39",
    older: false,
    label: "v0.7.39-beta.12+build.2026",
  }, "the cell shows the x.y.z core, the label keeps the full version");
  assert.deepEqual(
    deviceSegments({ platform: "android", version: "0.7.30", hubVersion: "0.7.39", folders: 1, size: 3 * GB, revoked: true }),
    [{ parts: ["Android"] }, { parts: ["1 folder", "3.0 GB"] }],
    "the phone line drops a removed device's version",
  );
  assert.equal(
    machineLabel({ name: "Yuri", role: "Replica", segments: [], presence: { connected: false, label: "Seen Oct 7, 10:01" } }),
    "Yuri, Replica, Seen Oct 7, 10:01",
  );
  assert.equal(
    machineLabel({ name: "nas", role: "Replica", segments: [{ parts: ["Linux"] }], version: "v0.7.39" }),
    "nas, Replica, Linux, v0.7.39",
  );
});

test("phone rows carry presence as a tile badge and the Fold lays the row out in cells, wired from the roster", () => {
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("export function MachineRow("), components.indexOf("export function SettingsGroup("));
  assert.match(row, /\{!wide && !!presence && <View style=\{\[s\.presenceBadge, !presence\.connected && s\.presenceOff\]\} \/>\}/, "the phone's presence is a badge on the tile corner");
  assert.match(row, /!wide && s\.machineTileTop/);
  assert.match(row, /<View style=\{\[s\.stack, s\.machineNameBlock\]\}>[\s\S]*?<View style=\{\[s\.machineCell, s\.machineCellVersion\]\}>[\s\S]*?<View style=\{\[s\.machineCell, s\.machineCellFolders\]\}>[\s\S]*?<View style=\{\[s\.machineCell, s\.machineCellSeen\]\}>[\s\S]*?<View style=\{s\.machineEnd\}>/, "the Fold row: name block, version, folders over size, last seen, then the end");
  assert.match(row, /cells\.version\.older && <Icon name="circle-arrow-up" size=\{g\.pillIcon\} color=\{c\.warning\} \/>/);
  assert.match(row, /<Text style=\{\[s\.machineCellText, s\.machineCellMute\]\}>\{cells\.totals\[1\]\}<\/Text>/, "the size sits under the folder count in mute");
  assert.match(row, /<View style=\{\[s\.presenceDot, !presence\.connected && s\.presenceOff\]\} \/>\s+<Text style=\{s\.machineCellText\}>\{presence\.label\}<\/Text>/);
  assert.match(row, /\[os, address\]\.filter\(Boolean\)/, "the Fold's hub address shares its OS line");
  assert.match(row, /segments: wide \? segments\.filter\(\(segment\) => !segment\.warning && !segment\.version\) : segments,[\s\S]{0,80}version: wide \? cells\?\.version\?\.label : "",/, "the Fold reads the version it shows, once");
  const theme = read("theme.js");
  assert.match(theme, /presenceBadge: \{\s+position: "absolute",\s+top: -6,\s+right: -6,\s+width: 12,\s+height: 12,\s+borderRadius: 6,\s+borderWidth: 2,\s+borderColor: c\.surface,\s+backgroundColor: c\.accent,\s+\}/);
  assert.match(theme, /presenceOff: \{ backgroundColor: c\.mute \}/);
  assert.match(theme, /machineTileTop: \{ marginTop: \(g\.touchRowLine \+ g\.touchCaptionLine \+ 4 - 32\) \/ 2 \}/, "the tile centres on the first two lines");
  assert.match(theme, /machineHeadAction: \{ marginVertical: \(g\.touchRowLine - g\.buttonSmallHeight\) \/ 2 \}/, "Disconnect never stretches the name line");
  assert.match(theme, /machineColumns: \{ gap: 8 \}/);
  assert.match(theme, /machineNameBlock: \{ flexGrow: 0, flexShrink: 1, flexBasis: 172, minWidth: 0 \}/, "the name block gives way before the row overflows");
  assert.match(theme, /machineCellSeen: \{ flexGrow: 1, flexShrink: 1, minWidth: 0 \}/, "last seen absorbs the slack, so the other columns align and the right edge never overflows");
  assert.match(theme, /machineCellVersion: \{ width: Math\.ceil\(76 \* fontScale \* textScale\) \}/, "fixed: the 13 dp arrow, a 4 dp gap and v10.10.10 measure 73 dp at the pill font");
  assert.match(theme, /machineCellFolders: \{ width: Math\.ceil\(66 \* fontScale \* textScale\) \}/, "fixed: 100 and 999 folders measure 62 dp and 1023.9 GB 59 dp at the pill font, with room for Android metrics");
  assert.match(theme, /machineCellText: \{\s+fontFamily: "InstrumentSans_400Regular",\s+fontSize: g\.pillFont,\s+lineHeight: g\.pillLine,\s+color: c\.soft,\s+\}/);
  assert.match(theme, /compactButton: \{ paddingVertical: 0, paddingLeft: g\.pillLeft, paddingRight: g\.pillRight, gap: g\.pillGap \}/);
  assert.match(theme, /compactLabel: \{ fontSize: g\.pillFont, lineHeight: g\.pillLine \}/);
  const hub = read("HubConnection.jsx");
  assert.match(hub, /iconOnly=\{!wide\}\s+size=\{wide \? "compact" : "small"\}/, "a 32 caution square on the phone, a compact labelled button on the Fold");
  assert.match(hub, /presence=\{presence\}/);
  const app = read("App.jsx");
  assert.match(app, /const devicePresence = rosterPresence\(machines, \{\s+offline: machinesSaved \|\| status\.offline,\s+connectionId: connection\?\.id,\s+\}\);/);
  assert.equal((app.match(/presence=\{devicePresence\.hub\}/g) || []).length, 1, "the hub row appears once, in Devices");
  assert.match(app, /presence=\{presence\(\{ self: true \}\)\}/);
  assert.match(app, /presence=\{devicePresence\.of\(m\)\}/);
  assert.match(app, /revoked: m\.revoked,\s+player: m\.role === "player",\s+\}\)\}\s+cells=\{deviceCells\(\{/);
  assert.match(app, /role=\{m\.role === "player" \? "Player" : m\.role \|\| "Replica"\}/);
  assert.match(app, /!m\.isHub &&\s+m\.role !== "player" &&\s+m\.credentialId !== connection\?\.id/, "a player is never listed as holding a copy");
  assert.match(read("components.jsx"), /name=\{hub \? "server" : player \? "tv" : /);
  assert.match(read("icons.js"), /"circle-arrow-up": "CircleArrowUp"/);
});

test("the Fold keeps its cell row only while it fits 690 dp, and falls back to the phone row at large text", async () => {
  const { textSizes } = await import("../apps/mobile/src/text-size.js");
  const largest = Math.max(...textSizes.map((size) => size.value));
  assert.equal(largest, 1.3);
  assert.equal(foldRowFits(1), true);
  assert.equal(foldRowFits(1.2), true);
  assert.equal(foldRowFits(largest), false, "Largest text alone no longer fits");
  assert.equal(foldRowFits(largest * 1.3), false, "Largest with system scale 1.3 uses the phone row");
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("export function MachineRow("), components.indexOf("export function SettingsGroup("));
  assert.match(row, /const \{ s, c, wide: wideLayout, fontScale = 1 \} = useDesign\(\);\s+const wide = wideLayout && foldRowFits\(fontScale\);/);
  assert.match(read("HubConnection.jsx"), /const wide = wideLayout && foldRowFits\(fontScale\);/, "the hub's Disconnect follows the same layout");
  assert.match(read("App.jsx"), /fontScale: fontScale \* textScale\(prefs\.textSize\),/, "the scale is the system font scale times the app text size");
});

test("a player reads its app and own version, the folders it streams, and never the hub's version warning", () => {
  const player = { platform: "android", app: "Arca TV", version: "1.0.0", hubVersion: "0.7.84", folders: 2, size: 0, player: true };
  assert.deepEqual(deviceSegments(player), [{ parts: ["Arca TV"] }, { parts: ["v1.0.0"], label: "v1.0.0", version: true }, { parts: ["2 folders", "Streaming"] }]);
  assert.match(read("components.jsx"), /segments\.filter\(\(segment\) => !segment\.warning && !segment\.version\)/, "the Fold reads a player's version once, from its cell");
  assert.deepEqual(deviceCells(player), { version: { text: "v1.0.0", older: false, label: "v1.0.0" }, totals: ["2 folders", "Streaming"] });
  assert.deepEqual(deviceSegments({ ...player, app: "" })[0], { parts: ["Android"] }, "without an app it falls back to the OS");
  assert.deepEqual(deviceSegments({ platform: "android", app: "Arca TV", folders: 2, size: GB }), [{ parts: ["Android"] }, { parts: ["2 folders", "1.0 GB"] }], "a replica keeps its OS and size");
});
