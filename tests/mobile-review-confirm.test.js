import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as copy from "../apps/mobile/src/confirm-copy.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");

test("confirmations name their target and the verb and object of the action", () => {
  assert.equal(copy.deleteFile("docs/work/inv.pdf", false, false).title, "Delete “inv.pdf”?");
  assert.equal(copy.deleteFile("docs/work/inv.pdf", false, false).label, "Delete file");
  assert.equal(copy.deletePlaylist("Road", false, false).title, "Delete “Road”?");
  assert.equal(copy.deleteTrack("Intro", false).title, "Delete “Intro”?");
  const photos = copy.deletePhotos([{}, {}]);
  assert.equal(photos.title, "Delete 2 photos?");
  assert.equal(photos.label, "Delete 2 photos");
  assert.equal(copy.deletePhotos({}).label, "Delete photo");
  const restore = copy.restoreVersion({ path: "a/b.txt", rev: 7 }, "Oct 3, 14:05");
  assert.equal(restore.title, "Restore “b.txt”?");
  assert.match(restore.message, /Oct 3, 14:05 \(rev 7\)/);
  assert.equal(restore.destructive, false);
  assert.equal(copy.disconnectHub().destructive, true);
});

test("erase and stop syncing start with the real numbers and keep the safety sentence", () => {
  const erase = copy.eraseDevice({ folders: 3, size: 1073741824, pending: 2 });
  assert.match(erase.message, /^3 folders · 1\.0 GB on this phone will be deleted; 2 files not yet on the hub\. /);
  assert.match(erase.message, /This cannot be undone\./);
  assert.match(copy.eraseDevice({ folders: 1, size: 10, pending: 0 }).message, /^1 folder · 10 B .*Everything is on the hub\./);
  assert.match(copy.eraseDevice({ folders: 1, size: 10, pending: null }).message, /could not be counted/);
  const stop = copy.stopSyncing({ name: "docs", files: 12, size: 2048, pending: 1, sourceOnly: false });
  assert.match(stop.message, /^12 files · 2\.0 KB on this phone will be deleted; 1 file not yet on the hub\. Removes this folder’s copy from this phone/);
  assert.match(copy.stopSyncing({ name: "p", files: 1, size: 1, pending: 0, sourceOnly: true }).message, /album link/);
});

test("the confirmation dialog stacks the action over Cancel and never infers danger from the label", () => {
  const components = read("components.jsx");
  const dialog = components.slice(components.indexOf("export function ConfirmDialog("), components.indexOf("export function ActionRow("));
  assert.ok(dialog.indexOf("label={label}") < dialog.indexOf('label="Cancel"'));
  assert.match(read("theme.js"), /confirmActions: \{ flexDirection: "column", alignItems: "stretch"/);
  const app = read("App.jsx");
  assert.doesNotMatch(app, /\/stop syncing\/i\.test|\/erase\|delete/);
  assert.match(app, /destructive=\{shownConfirmation\.destructive\}/);
  for (const spec of Object.keys(copy)) assert.ok(app.includes(`confirmCopy.${spec}(`), `${spec} is used`);
});

test("photo selection pins its bar above the tab bar and unselected tiles show the empty circle", () => {
  const gallery = read("FolderGallery.jsx");
  assert.doesNotMatch(gallery, /Clear selection|selected…/);
  assert.match(gallery, /onSelection\?\.\(\s*selection\.length/);
  assert.match(gallery, /useEffect\(\(\) => \(\) => onSelection\?\.\(null\), \[\]\)/);
  assert.match(gallery, /!selected && selecting && size >= 40 && \(\s*<View pointerEvents="none" style=\{s\.photoRing\}/);
  assert.match(gallery, /selecting=\{!!selection\.length\}/);
  const components = read("components.jsx");
  const bar = components.slice(components.indexOf("export function SelectionBar("), components.indexOf("export function ActionRow("));
  assert.match(bar, /`\$\{count\} selected`/);
  assert.match(bar, /label="Clear"/);
  assert.match(bar, /label="Delete…" danger disabled=\{!linked\}/);
  assert.match(bar, /!linked && <Text style=\{s\.caption\}>\{reason\}/);
  const app = read("App.jsx");
  assert.ok(app.indexOf("<SelectionBar") < app.indexOf("<Navigation\n                    view={view}"));
  assert.match(app, /onSelection=\{setPhotoSelection\}/);
});

test("a History row leads with the file name and moves the folders into the caption", async () => {
  const { historyPath } = await import("../apps/mobile/src/home-data.js");
  assert.deepEqual(historyPath("documents/work/2024/inv.pdf"), { name: "inv.pdf", dir: "documents/work/2024" });
  assert.deepEqual(historyPath("notes.md"), { name: "notes.md", dir: "" });
  const app = read("App.jsx");
  assert.match(app, /\{historyPath\(row\.path\)\.name\}/);
  assert.match(app, /`\$\{historyPath\(row\.path\)\.dir\} · `/);
  assert.doesNotMatch(app, /!!row\.deleted && s\.deletedFile,\s*\]\}\s*>\s*\{row\.path\}/);
});

test("a rejected pairing code is explained under the field and offers no retry", async () => {
  const { rejectedCode } = await import("../apps/mobile/src/pairing.js");
  assert.match(rejectedCode({ status: 401, message: "Pairing code invalid, expired or already used" }), /not valid or has expired/);
  assert.match(rejectedCode({ status: 429, message: "Pairing code invalidated after five failed attempts. Generate a new code." }), /five failed attempts/);
  assert.equal(rejectedCode({ status: 503, message: "Hub unavailable" }), null);
  assert.equal(rejectedCode(new Error("network")), null);
  const app = read("App.jsx");
  const redeem = app.slice(app.indexOf("  async function redeemCode()"), app.indexOf("  async function pendingFiles("));
  assert.match(redeem, /setCode\(""\);\s*setPairError\(message\);\s*return false;/);
  assert.match(app, /codeError=\{pairError\}/);
  const form = read("PairingForm.jsx");
  assert.match(form, /codeError \? \(/);
  assert.match(form, /Use HTTPS or Tailscale\.<\/Text>/);
  assert.doesNotMatch(form.replace(/\{details && \([\s\S]*?\)\}/, ""), /private\s+IPv4/);
  assert.match(form, /\{!!back && \(\s*<Button label="Back"/);
  assert.match(read("Onboarding.jsx"), /back=\{back\}/);
  assert.match(app, /back=\{\(\) =>\s*run\(\(\) => engine\.current\.store\.set\("onboarding", null\)\)/);
});

test("a phone pairs with its model name and falls back to the platform name", async () => {
  const { defaultDeviceName } = await import("../apps/mobile/src/device-name.js");
  assert.equal(defaultDeviceName({ OS: "android", constants: { Model: " Pixel 9 Pro Fold " } }), "Pixel 9 Pro Fold");
  assert.equal(defaultDeviceName({ OS: "android", constants: {} }), "Android");
  assert.equal(defaultDeviceName({ OS: "android" }), "Android");
  assert.equal(defaultDeviceName({ OS: "ios", constants: { Model: "x" } }), "iPhone");
  assert.equal(defaultDeviceName({ OS: "android", constants: { Model: "m".repeat(150) } }).length, 100);
  assert.doesNotMatch(read("App.jsx"), /Platform\.OS === "ios" \? "iPhone" : "Android"/);
});

test("the phone tab bar flags Settings when the device needs attention and the Fold rail names each destination", () => {
  const components = read("components.jsx");
  assert.match(components, /!wide && tab === "Settings" && device\?\.tone \? `\$\{tab\}, \$\{device\.word\}` : tab/);
  assert.match(components, /!wide && tab === "Settings" && !!device\?\.tone && \(\s*<View\s+pointerEvents="none"\s+style=\{\[s\.tabDot, device\.tone === "danger" && s\.tabDotDanger\]\}/);
  assert.doesNotMatch(components, /\{!compact && \(\s*<Text/);
  const theme = read("theme.js");
  assert.match(theme, /width: compact \? 72 : 200/);
  assert.match(theme, /compactNavLabel: \{/);
  assert.match(read("App.jsx"), /name=\{name\}\s+device=\{device\}\s+\/>\s*\)\}\s*<\/View>\s*<\/KeyboardPane>/);
});

test("a failed phone search shows the shared error notice with Retry, not No matches", () => {
  const search = read("GlobalSearch.jsx");
  assert.match(search, /setFailure\(error\?\.message \|\| "Search could not finish\."\)/);
  assert.doesNotMatch(search, /setResults\(\{ groups: \[\] \}\)/);
  assert.match(search, /<ErrorNotice error=\{failure\} retry=\{\(\) => setAttempt/);
  assert.match(search, /results && !failure && !items\.length/);
  assert.match(search, /catch \{\s*setMoreFailure\("Could not load more results\."\)/);
  assert.match(search, /<ErrorNotice error=\{moreFailure\} retry=\{more\}/);
});

test("the search filter chip and its remove button meet the touch height", () => {
  const theme = read("theme.js");
  assert.match(theme, /searchChip: \{[^}]*minHeight: g\.touchControlHeight,/);
  assert.match(theme, /searchChipRemove: \{ width: g\.touchControlHeight, height: g\.touchControlHeight,/);
});

test("section labels are one component that uppercases through style and carries the header role", () => {
  const theme = read("theme.js");
  assert.match(theme, /eyebrow: \{[^}]*textTransform: "uppercase"/s);
  assert.match(read("components.jsx"), /export function Eyebrow\(\{ children, style \}\) \{[\s\S]*?accessibilityRole="header" style=\{\[s\.eyebrow, style\]\}/);
  const sources = fs.readdirSync(new URL("../apps/mobile/src/", import.meta.url)).filter((name) => name.endsWith(".jsx"));
  for (const name of sources) {
    const source = read(name);
    assert.doesNotMatch(source, /<Text style=\{\[?s\.eyebrow[^>]*>\s*[A-Z][A-Z &·]{3,}\s*<\/Text>/, `${name} types a section label in capitals`);
    assert.doesNotMatch(source, /<Eyebrow[^>]*>\s*\{?[^<]*(?:toUpperCase|[A-Z]{4,})/, `${name} types its own casing`);
  }
});

test("onboarding offers Stream or Keep for media, sizes only what downloads and names the action by what starts", async () => {
  const { defaultMode, downloadBytes, mediaKind, startLabel } = await import("../apps/mobile/src/onboarding.js");
  const catalog = { music: true, video: true, volumes: [{ id: "a", music: true }, { id: "v", video: true }, { id: "d" }] };
  assert.equal(mediaKind(catalog, { id: "a" }, true), "audio");
  assert.equal(mediaKind(catalog, { id: "a" }, false), null, "the iPhone only keeps an Audio library");
  assert.equal(mediaKind(catalog, { id: "v" }, false), "video");
  assert.equal(mediaKind(catalog, { id: "d" }, true), null);
  assert.equal(defaultMode("audio"), "keep");
  assert.equal(defaultMode("video"), "stream");
  const folders = [{ id: "a", bytes: 10 }, { id: "v", bytes: 100 }, { id: "d", bytes: 5 }];
  assert.equal(downloadBytes(folders, { a: "stream", v: "stream", d: "keep" }), 5);
  assert.equal(downloadBytes(folders, { a: "keep", v: "keep", d: "keep" }), 115);
  assert.equal(downloadBytes(folders, { a: "keep", v: "keep", d: "keep" }, { v: 60 }), 75, "a known playable size replaces the folder size");
  assert.deepEqual(startLabel([], {}), { label: "Choose folders", icon: null });
  assert.deepEqual(startLabel(folders.slice(0, 2), { a: "stream", v: "stream" }), { label: "Start streaming", icon: "play" });
  assert.deepEqual(startLabel(folders, { a: "stream", v: "stream", d: "keep" }), { label: "Start syncing 3 folders", icon: "refresh" });
  const screen = read("Onboarding.jsx");
  assert.match(screen, /Folders are kept on this \{device\}; music and movies can stream instead\. Add more any time\./);
  assert.match(screen, /const folders = catalog\?\.volumes \|\| \[\];/, "Movies & TV libraries are offered too");
  assert.match(screen, /description=\{folder\.policyError \|\| \(modes\[folder\.id\] === "stream" \? "Streams from hub" : folderSize\(folder\)\)\}/);
  assert.match(screen, /\{!!kinds\[folder\.id\] && selected\.includes\(folder\.id\) && \(\s+<SegmentedControl/);
  assert.match(screen, /\{bytes\(downloadBytes\(chosen, modes, sizes\)\)\} to download ·/);
  assert.match(screen, /label=\{action\.label\}\s+icon=\{action\.icon\}\s+primary\s+disabled=\{!chosen\.length\}[\s\S]{0,60}onPress=\{\(\) => download\(chosen\.map\(\(folder\) => folder\.id\), modes\)\}/);
  assert.match(read("App.jsx"), /audioStreams=\{playerAvailable\}\s+sizes=\{keptSizes\}/);
  assert.match(read("App.jsx"), /download=\{\(ids, modes\) =>[\s\S]{0,600}await selectFirstFolders\(r, client\.state\(\)\.catalog, ids, modes, Platform\.OS\);/);
});

test("tapping the scrim or dragging the grabber down dismisses a sheet unless it is busy", async () => {
  const { draggedDown } = await import("../apps/mobile/src/sheet-dismiss.js");
  assert.equal(draggedDown({ dy: 80, vy: 0.1 }), true);
  assert.equal(draggedDown({ dy: 30, vy: 1.2 }), true);
  assert.equal(draggedDown({ dy: 30, vy: 0.2 }), false);
  assert.equal(draggedDown({ dy: -90, vy: -2 }), false);
  const components = read("components.jsx");
  const sheet = components.slice(components.indexOf("export function Sheet("), components.indexOf("export function ConfirmDialog("));
  assert.match(sheet, /const dismiss = \(\) => \{\s+if \(busy \|\| leaving\.current\) return;\s+onClose\?\.\(\);/);
  assert.match(sheet, /onPress=\{dismiss\}\s+style=\{s\.modalScrim\}/);
  assert.match(sheet, /if \(draggedDown\(gesture\)\) dismissRef\.current\(\)/);
  assert.match(sheet, /<View \{\.\.\.grabber\.panHandlers\} style=\{s\.sheetGrabber\}>\s+<View style=\{s\.sheetHandle\} \/>/);
});

test("a denied notification permission offers Open settings and the toggle reads the real permission", async () => {
  const { NOTIFICATIONS_DENIED, notificationsOn, settingsAction } = await import("../apps/mobile/src/notification-permission.js");
  const denied = settingsAction({ action: "retry", actionLabel: "Retry now" }, NOTIFICATIONS_DENIED);
  assert.deepEqual([denied.action, denied.actionLabel], ["settings", "Open settings"]);
  assert.equal(settingsAction({ action: "retry", actionLabel: "Retry now" }, "OTHER").action, "retry");
  assert.equal(notificationsOn(true, false), false);
  assert.equal(notificationsOn(true, true), true);
  assert.equal(notificationsOn(true, null), true);
  assert.equal(notificationsOn(false, true), false);
  assert.match(read("runtime.js"), /code: NOTIFICATIONS_DENIED/);
  const app = read("App.jsx");
  assert.match(app, /item\.action === "settings"\) \{\s+setError\(""\);\s+Linking\.openSettings\(\)/);
  assert.match(app, /if \(view !== "Settings"\) return;[\s\S]*?notificationsGranted\(\)\.then[\s\S]*?\[view, focusTick\]/);
  assert.match(app, /if \(value === "active"\) \{\s+setFocusTick/);
  assert.match(app, /value=\{notificationsOn\(prefs\.notifications, notificationAllowed\)\}/);
});

test("a first-sync folder says Waiting while a cycle runs, and Folders and folder detail share one state vocabulary", async () => {
  const { folderStatus } = await import("../apps/mobile/src/home-data.js");
  const base = { paused: false, issue: null, offline: false, connected: true, syncing: false, completed: null, pending: false, cycle: false };
  assert.equal(folderStatus({ ...base, cycle: true }), "Waiting");
  assert.equal(folderStatus({ ...base }), "Not yet synced");
  assert.equal(folderStatus({ ...base, completed: "2026-01-01", pending: true }), "Incomplete");
  assert.equal(folderStatus({ ...base, completed: "2026-01-01" }), "Up to date");
  assert.equal(folderStatus({ ...base, syncing: true, cycle: true }), "Syncing");
  assert.equal(folderStatus({ ...base, paused: true, issue: "x" }), "Paused");
  assert.equal(folderStatus({ ...base, issue: "x", offline: true }), "Needs attention");
  assert.equal(folderStatus({ ...base, connected: false }), "Disconnected");
  const app = read("App.jsx");
  assert.equal(app.split("folderStatus({").length - 1, 2, "the list and the detail card use the same function");
  assert.match(app, /state === "Waiting" && Number\.isFinite\(remote\?\.bytes\)\s+\? unbroken\(`\$\{bytes\(remote\.bytes\)\} to download`\)/);
});

test("a mounted notice is announced with its title and body", async () => {
  const { noticeAnnouncement } = await import("../apps/mobile/src/notice-announce.js");
  assert.equal(noticeAnnouncement({ title: "Conflict in docs", body: "Both files were kept." }), "Conflict in docs. Both files were kept.");
  assert.equal(noticeAnnouncement({ title: "Saved" }), "Saved");
  const notice = read("Notice.jsx");
  assert.match(notice, /if \(!leaving\) announceNotice\(item\);\s+\}, \[item\.created, item\.title, item\.body\]\)/);
  assert.match(read("announce.js"), /Platform\.OS === "ios" && AccessibilityInfo\.announceForAccessibility\(noticeAnnouncement\(item\)\)/);
});

test("segmented controls meet the touch height, the Text size control scrolls and labels stay on one line", () => {
  assert.match(read("theme.js"), /segment: \{\s+flex: wide \? 0 : 1,\s+paddingHorizontal: wide \? 12 : 0,\s+minHeight: g\.touchHeight,/);
  assert.match(read("components.jsx"), /<Text\s+numberOfLines=\{1\}\s+style=\{\[\s+s\.buttonLabel,\s+s\.segmentText,/);
  assert.match(read("components.jsx"), /<Text\s+numberOfLines=\{1\}\s+maxFontSizeMultiplier=\{wide && compact \? railLabelFontCap : undefined\}\s+style=\{\[\s+wide \? \(compact \? s\.compactNavLabel : s\.navLabel\) : s\.caption,/);
  assert.match(read("App.jsx"), /options=\{textSizes\}\s+scroll\s+value=\{textScale\(prefs\.textSize\)\}/);
});

test("View details opens the file page and Open with the external icon stays the app handoff", () => {
  const app = read("App.jsx");
  assert.match(app, /<Button label="View details" onPress=\{\(\) => openFileDetail\(previewEntry\)\} \/>/);
  assert.match(app, /label="View details"\s+onPress=\{\(\) => \{\s+const entry = shownSheet\.entry;\s+setSheet\(null\);\s+openFileDetail\(entry\);/);
  assert.match(app, /label="Open"\s+icon="external"[\s\S]*?runLocal\(openCurrentFile\)/);
  assert.doesNotMatch(app, /label="Open"\s+onPress=\{\(\) => \{\s+const entry/);
});

test("disabled folder actions say why", async () => {
  const { albumNote, historyNote, uploadsNote } = await import("../apps/mobile/src/folder-actions.js");
  const album = { source: null, locked: false, connected: true, offline: false, completed: "x", issue: null };
  assert.equal(albumNote(album), undefined);
  assert.equal(albumNote({ ...album, offline: true }), "Needs the hub, which is unavailable.");
  assert.equal(albumNote({ ...album, locked: true }), "Another action is still running.");
  assert.equal(albumNote({ ...album, connected: false }), "Connect to the hub first.");
  assert.equal(albumNote({ ...album, issue: "x" }), "Fix this folder's sync problem first.");
  assert.equal(albumNote({ ...album, completed: null }), "Available after this folder's first sync.");
  assert.equal(albumNote({ ...album, source: { mode: "source" }, completed: null }), undefined);
  assert.equal(historyNote({ busy: false, connected: true }), undefined);
  assert.equal(historyNote({ busy: true, connected: true }), "Another action is still running.");
  assert.equal(historyNote({ busy: false, connected: false }), "Connect to the hub first.");
  assert.equal(uploadsNote({ busy: false, mode: "source" }), undefined);
  assert.match(uploadsNote({ busy: false, mode: "converting" }), /finishes/);
  assert.match(uploadsNote({ busy: false, mode: "damaged" }), /repair/);
  const app = read("App.jsx");
  assert.match(app, /note=\{albumNote\(\{/);
  assert.match(app, /note=\{historyNote\(\{ busy, connected \}\)\}/);
  assert.match(app, /note=\{uploadsNote\(\{ busy, mode: source\.mode \}\)\}/);
});

test("pulling to refresh or pressing Sync now while paused says Sync is paused with Resume", async () => {
  const { PAUSED_REASON } = await import("../apps/mobile/src/folder-actions.js");
  assert.equal(PAUSED_REASON, "Sync is paused");
  const app = read("App.jsx");
  assert.match(app, /if \(status\.paused\) return explainPause\(\);\s+setPulling\(true\);/);
  assert.match(app, /reason=\{status\.paused \? PAUSED_REASON : undefined\}\s+onReason=\{explainPause\}/);
  assert.match(app, /title: PAUSED_REASON,\s+action: "resume",\s+actionLabel: "Resume"/);
  assert.match(app, /item\.action === "resume"\) \{\s+notices\.clear\(item\.id\);\s+run\(async \(\) => \{\s+await engine\.current\.pause\(false\);\s+startSync\(\);/);
  const components = read("components.jsx");
  assert.match(components, /accessibilityHint=\{explained \? reason : undefined\}/);
  assert.match(components, /disabled=\{\(disabled && !explained\) \|\| busy\}\s+onPress=\{explained \? \(\) => onReason\?\.\(reason\) : onPress\}/);
});

test("a saved share confirms with an Open action and the no-folder state keeps the shared files", () => {
  const share = read("IncomingShare.jsx");
  assert.match(share, /const saved = \{ count: items\.length, folder: volume, directory \};[\s\S]*?await onSaved\(saved\);/);
  assert.match(share, /<EmptyState\s+icon="folders"\s+title="No folder to save into"/);
  assert.match(share, /setParked\(true\);\s+setOpen\(false\);\s+onChoose\?\.\(\);/);
  assert.doesNotMatch(share.slice(share.indexOf("Open Folders")-300, share.indexOf("Open Folders")+200), /discard\(\)/);
  assert.match(share, /if \(parked && destinations\.length && items\.length\) \{\s+setParked\(false\);\s+setOpen\(true\);/);
  const app = read("App.jsx");
  assert.match(app, /title: `Saved \$\{fileCount\(saved\)\} to \$\{target\.name\}`/);
  assert.match(app, /engine\.current\?\.paused \|\| status\.offline \|\| !connected\s+\? "Waiting to upload\."/);
  assert.match(app, /action: "folder",\s+actionLabel: "Open",\s+volume: target\.id/);
  assert.match(app, /onSaved=\{savedShare\}\s+onChoose=\{\(\) => selectTab\("Folders"\)\}/);
});

test("the History folder filter is announced with its value, marks the current folder and says a second tap clears", () => {
  const app = read("App.jsx");
  assert.match(app, /accessibilityLabel=\{`Shared folder, \$\{historyFolderName\}`\}/);
  assert.match(app, /selectable\s+selected=\{historyVolume === v\.id\}/);
  assert.match(app, /value=\{historyFilter\}\s+clearable/);
  assert.match(read("components.jsx"), /accessibilityHint=\{clearable && value === option\.value \? "Tap again to clear" : undefined\}/);
});

test("Recent and History offline use the shared offline empty state with Retry and Open Devices", () => {
  const components = read("components.jsx");
  assert.match(components, /<Button label="Retry" icon="refresh" onPress=\{retry\} \/>\s+\{!!devices && <Button label="Open Devices" onPress=\{devices\} \/>\}/);
  const recent = read("FolderRecent.jsx");
  assert.match(recent, /if \(!connected && !page\)\s+return \(\s+<OfflineEmpty[\s\S]*?devices=\{devices\}/);
  const app = read("App.jsx");
  assert.match(app, /\{!connected && \(\s+<OfflineEmpty\s+icon="history"[\s\S]*?devices=\{\(\) => setView\("Devices"\)\}/);
  assert.match(app, /history\.offline \? \(\s+<OfflineEmpty\s+\{\.\.\.historyEmpty\(\{ offline: true \}\)\}/);
  assert.match(app, /devices=\{\(\) => setView\("Devices"\)\}\s+date=\{date\}/);
});

test("file rows read name and size, folder rows say folder, photo tiles read their date and the current queue row is not a button", async () => {
  const { entryLabel, tileLabel } = await import("../apps/mobile/src/browse.js");
  assert.equal(entryLabel({ label: "a.txt", size: 2048 }), "a.txt, 2.0 KB");
  assert.equal(entryLabel({ label: "docs", directory: true, count: 12, size: 1048576 }), "docs, folder, 12 files, 1.0 MB");
  assert.equal(entryLabel({ label: "docs", directory: true, count: 1, size: 0 }), "docs, folder, 1 file, 0 B");
  assert.equal(tileLabel({ kind: "image", date: "2026-09-14T10:00:00Z", path: "a/IMG_1.jpg" }), "Photo, Sep 14, 2026");
  assert.equal(tileLabel({ kind: "video", date: "2026-09-14", path: "a/MOV_1.mp4" }), "Video, Sep 14, 2026");
  assert.equal(tileLabel({ kind: "image", path: "a/IMG_1.jpg" }), "Photo IMG_1.jpg");
  assert.match(read("App.jsx"), /accessibilityLabel=\{entryLabel\(e\)\}/);
  assert.match(read("FolderGallery.jsx"), /: tileLabel\(item\)/);
  const now = read("NowPlayingPage.jsx");
  assert.match(now, /accessibilityRole=\{current \? "text" : "button"\}[\s\S]*?disabled=\{current\}/);
  assert.match(now, /<Row track=\{track\} current \/>/);
});

test("a tap on the picture closes an open panel and a stopped stream offers Try again beside Close", () => {
  const player = read("VideoPlayer.jsx");
  assert.match(player, /onPress=\{\(\) => \(panel \? \(setPanel\(null\), wake\(\)\) : controls \? setControls\(false\) : wake\(\)\)\}/);
  assert.match(player, /<Button label="Try again" icon="refresh" primary onPress=\{tryAgain\} \/>\s+<Button label="Close" onPress=\{close\} \/>/);
  assert.match(player, /const tryAgain = \(\) => \{\s+retried\.current = false;\s+restarter\.current\.now\(\{ start: model\.current\.position, audio: chosenAudio\.current \}\);/);
});

test("the music grids keep their page size and scroll offset per route entry", async () => {
  const memory = await import("../apps/mobile/src/list-memory.js");
  const key = memory.entryKey("music", [{ kind: "artist", id: "a1" }]);
  assert.equal(key, "music:artist:a1");
  assert.equal(memory.pageSize(`${key}:albums`, 60), 60);
  memory.keepPage(`${key}:albums`, 180);
  assert.equal(memory.pageSize(`${key}:albums`, 60), 180, "back from an album restores the grown page");
  assert.equal(memory.pageSize("other:albums", 60), 60);
  assert.equal(memory.scrollOffset(key), 0);
  memory.keepScroll(key, 1234);
  assert.equal(memory.scrollOffset(key), 1234);
  for (let index = 0; index < 100; index++) memory.keepPage(`bounded:${index}`, index);
  assert.equal(memory.pageSize("bounded:0", 7), 7, "the oldest entries are forgotten");
  assert.equal(memory.pageSize("bounded:99", 7), 99);
  const library = read("MusicLibrary.jsx");
  assert.doesNotMatch(library, /useState\((?:60|PAGE)\)/);
  assert.match(library, /const \[shown, showMore\] = usePaged\(`\$\{memory\}:albums`, 60, 60\);/);
  assert.match(library, /const \[shown, showMore\] = usePaged\(`\$\{memory\}:shows`, 60, 60\);/);
  assert.match(library, /keepScroll\(leftKey\.current, place\?\.offset\(\) \?\? 0\)/);
  assert.match(read("KeyboardPane.jsx"), /offset: \(\) => offset\.current,/);
});

test("the music Loading the library state uses the shared scaffold with Sync now as a secondary action", () => {
  const library = read("MusicLibrary.jsx");
  assert.match(library, /<Scaffold label="Loading the library" \/>[\s\S]*?<Button label="Sync now" icon="refresh" quiet onPress=\{sync\} \/>/);
  assert.doesNotMatch(library, /title="Loading the library"/);
});

test("Now playing is two panes from the shared wide breakpoint, not a private 1100 dp threshold", () => {
  const page = read("NowPlayingPage.jsx");
  assert.match(page, /const twoPane = wide;/);
  assert.doesNotMatch(page, /1100/);
});

test("Settings does not repeat itself: the name joins the This device row, the hub row lives in Devices and Runtime merges into Background refresh", () => {
  const app = read("App.jsx");
  const settings = app.slice(app.indexOf('{screen === "Settings" && ('));
  assert.match(settings, /<DeviceRow name=\{name\} device=\{device\}>\s+<Field\s+label="Device name"/);
  assert.doesNotMatch(settings, /<HubConnection|Hub connection|title="Runtime"|Mobile app/);
  assert.match(settings, /label="Background refresh"\s+description="Sync runs while the app is open\. In the background it depends on this device’s permissions and system limits\."/);
  const order = ["This device", "Local synchronization", "Mobile preferences", "Storage", "Service", "Appearance"].map((name) => settings.indexOf(`<Eyebrow>${name}</Eyebrow>`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((at) => at >= 0));
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("export function DeviceRow("), components.indexOf("export function RoleChip("));
  assert.match(row, /\{children\}\s+<\/View>/);
});

test("phone notices have one dismiss control: the 44 dp cross, and an action row only for the notice's own action", () => {
  const notice = read("Notice.jsx");
  assert.doesNotMatch(notice, /Dismiss<\/Text>/);
  assert.match(notice, /\{!!item\.action && \(\s+<View style=\{s\.noticeActions\}>\s+<Pressable/);
  assert.match(notice, /accessibilityLabel="Dismiss notification"[\s\S]*?style=\{s\.noticeClose\}\s+>/);
  assert.match(read("theme.js"), /noticeClose: \{\s+width: g\.touchHeight,\s+height: g\.touchHeight,/);
  assert.match(notice, /onMoveShouldSetPanResponder: \(_, g\) =>\s+g\.dy > 12/, "the swipe is unchanged");
});
