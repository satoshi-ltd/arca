import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { searchTokens } from "../packages/core/search.js";
import { SEARCH_PHOTOS, SEARCH_SHOWN, buildResults, forgetSearch, rememberSearch, searchCanReveal, searchItems, searchLanding, searchSubtitle, searchVerb, searchViewAction } from "../apps/mobile/src/search-local.js";
import { buildLibrary } from "../apps/mobile/src/music-library.js";

const volumes = [{ id: "a", name: "Documents" }, { id: "b", name: "Holiday photos", gallery: true }, { id: "m", name: "music" }];
const file = (path, rev, extra = {}) => ({ path, rev, size: 10, ...extra });
const rows = {
  a: [file("plans/site-plan.pdf", 3), file("plans/plan.txt", 5), file("old/planet.md", 4), file("deep/unplanned.txt", 2), file("gone-plan.txt", 9, { deleted: 1 }), file("folder", 8, { directory: true })],
  b: [file("2026/plan-b.jpg", 6), file("tracks/Planet Earth.mp3", 7), file("Ñandú.txt", 1), file("2025/09/sea.jpg", 2), file("2025/09/door.jpg", 1)],
  m: [file("Miles Davis/Kind of Blue/03 Blue in Green.mp3", 4), file("Playlists/Blue mood.m3u8", 3)],
};
const tag = (path, tags) => ({ path, hash: `h-${path}`, size: 1, title: null, artist: null, albumArtist: null, album: null, track: null, disc: null, year: null, duration: null, cover: null, added: null, ...tags });
const tracks = [
  tag("Miles Davis/Kind of Blue/03 Blue in Green.mp3", { title: "Blue in Green", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 3, cover: "k".repeat(64) }),
  tag("Miles Davis/Kind of Blue/01 So What.mp3", { title: "So What", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1 }),
  tag("Blue Mitchell/Moods/01 Close.mp3", { title: "Close", artist: "Blue Mitchell", albumArtist: "Blue Mitchell", album: "Moods", track: 1 }),
  tag("The Wild Project/2026-09-01 Blue zones.mp3", { title: "Blue zones", album: "The Wild Project", genre: "Podcast", duration: 3600 }),
];
const library = buildLibrary([{ id: "m", uri: (path) => `file:///${path}`, library: { version: "v", tracks, playlists: [{ path: "Playlists/Blue mood.m3u8", name: "Blue mood", entries: [tracks[0].path] }] }, present: new Map(tracks.map((track) => [track.path, track.hash])) }]);
const libraries = { m: library };
const photos = { b: [{ path: "2025/09/sea.jpg", date: "2025-09-21T10:00:00", kind: "image" }, { path: "2025/09/door.jpg", date: "2025-09-14T10:00:00", kind: "image" }, { path: "2026/plan-b.jpg", date: "2026-01-02", kind: "image" }] };
const group = (result, type) => result.groups.find((entry) => entry.type === type);

test("phone search ranks names across folders into the desktop palette's typed groups", () => {
  const all = buildResults({ query: "plan", volumes, rows, libraries, photos, limit: 6 });
  assert.deepEqual(all.groups.map((entry) => entry.type), ["photos", "files"]);
  assert.deepEqual(group(all, "files").rows.map((r) => r.name), ["plan.txt", "Planet Earth.mp3", "planet.md", "site-plan.pdf", "unplanned.txt"], "audio outside an audio library is a file");
  assert.deepEqual(group(all, "photos").rows.map((r) => [r.name, r.folder, r.kind, r.date]), [["plan-b.jpg", "Holiday photos", "image", "2026-01-02"]], "a photo carries its cached capture date");
  assert.equal(group(all, "files").count, 5);
  assert.ok(!JSON.stringify(all).includes("gone-plan"), "deleted files never match");
  assert.ok(!group(all, "files").rows.some((r) => r.path === "folder"), "directories never match");
});

test("an audio library answers with songs, albums, artists, shows, episodes and playlists that carry their library ids", () => {
  const blue = buildResults({ query: "blue", volumes, rows, libraries, photos });
  assert.deepEqual(blue.groups.map((entry) => entry.type), ["songs", "albums", "artists", "episodes", "playlists"]);
  const song = group(blue, "songs").rows[0];
  assert.deepEqual([song.title, song.artist, song.album, song.volume, song.id], ["Blue in Green", "Miles Davis", "Kind of Blue", "m", "m:Miles Davis/Kind of Blue/03 Blue in Green.mp3"]);
  assert.equal(song.albumId, group(blue, "albums").rows.find((row) => row.title === "Kind of Blue").id, "a song names the album it plays in");
  assert.deepEqual(group(blue, "artists").rows.map((row) => [row.name, row.albums, row.songs]), [["Blue Mitchell", 1, 1]]);
  const episode = group(blue, "episodes").rows[0];
  assert.deepEqual([episode.title, episode.show, episode.showId], ["Blue zones", "The Wild Project", library.showOrder[0]]);
  assert.ok(!group(blue, "songs").rows.some((row) => row.title === "Blue zones"), "a podcast is never a song");
  assert.deepEqual(group(blue, "playlists").rows.map((row) => [row.name, row.songs]), [["Blue mood", 1]]);
  assert.equal(group(blue, "files"), undefined, "audio and playlists in an audio library are not files");
  assert.deepEqual(group(buildResults({ query: "wild", volumes, rows, libraries }), "shows").rows.map((row) => row.name), ["The Wild Project"]);
  assert.deepEqual(group(buildResults({ query: "miles green", volumes, rows, libraries }), "songs").rows.map((row) => row.title), ["Blue in Green"], "every word must match");
});

test("a date finds photos from the gallery's cached dates, newest first, with the month to open", () => {
  for (const query of ["September 2025", "sep 2025", "2025-09"]) {
    const dated = group(buildResults({ query, volumes, rows, libraries, photos }), "photos");
    assert.equal(dated.count, 2, query);
    assert.equal(dated.label, "September 2025");
    assert.deepEqual(dated.rows.map((row) => row.name), ["sea.jpg", "door.jpg"]);
    assert.deepEqual(dated.periods, [{ volume: "b", folder: "Holiday photos", gallery: true, label: "September 2025", count: 2, month: "2025-09", path: "2025/09/sea.jpg" }]);
  }
});

test("a type narrows to one group and pages with an offset; folders, words and non-ASCII case", () => {
  assert.deepEqual(group(buildResults({ query: "holiday", volumes, rows }), "folders").rows.map((r) => r.name), ["Holiday photos"]);
  const narrowed = buildResults({ query: "plan", type: "files", volumes, rows, limit: 2 });
  assert.deepEqual(narrowed.groups.map((entry) => entry.type), ["files"]);
  assert.deepEqual(narrowed.groups[0].rows.map((r) => r.name), ["plan.txt", "Planet Earth.mp3"]);
  assert.equal(narrowed.groups[0].count, 5);
  assert.deepEqual(buildResults({ query: "plan", type: "files", volumes, rows, limit: 2, offset: 2 }).groups[0].rows.map((r) => r.name), ["planet.md", "site-plan.pdf"]);
  assert.equal(group(buildResults({ query: "plan", volumes, rows }), "files").rows.length, 4, "the screen asks for four and shows three rows or four photos");
  assert.deepEqual(group(buildResults({ query: "site pla", volumes, rows }), "files").rows.map((r) => r.name), ["site-plan.pdf"]);
  assert.deepEqual(group(buildResults({ query: "ÑANDÚ", volumes, rows }), "files").rows.map((r) => r.name), ["Ñandú.txt"]);
  assert.deepEqual(group(buildResults({ query: "nandu", volumes, rows }), "files").rows.map((r) => r.name), ["Ñandú.txt"], "accents fold away");
  assert.deepEqual(buildResults({ query: "  ", volumes, rows }), { groups: [] });
  assert.equal(SEARCH_SHOWN, 3);
  assert.equal(SEARCH_PHOTOS, 4);
});

test("recent searches keep five, newest first, without duplicates, and forget one", () => {
  let list = [];
  for (const text of ["a", "b", "c", "d", "e", "f", "c", "  "]) list = rememberSearch(list, text);
  assert.deepEqual(list, ["c", "f", "e", "d", "b"]);
  assert.deepEqual(forgetSearch(list, "f"), ["c", "e", "d", "b"]);
});

test("the screen lists three rows or four photos per group with Show all, and a type lists every loaded row with Show more", () => {
  const result = buildResults({ query: "blue", volumes, rows, libraries, photos });
  const items = searchItems(result, "");
  assert.deepEqual(items.filter((item) => item.of === "songs").map((item) => item.type), ["song", "song", "song"], "three songs, no Show all at exactly three");
  const files = searchItems(buildResults({ query: "plan", volumes, rows }), "");
  assert.deepEqual(files.filter((item) => item.of === "files").map((item) => item.type), ["file", "file", "file", "more"]);
  assert.equal(files.at(-1).title, "Show all 5 files");
  const typed = searchItems(buildResults({ query: "plan", type: "files", volumes, rows, limit: 2 }), "files");
  assert.deepEqual(typed.map((item) => item.type), ["file", "file", "page"]);
  const dated = searchItems(buildResults({ query: "september 2025", volumes, rows, photos }), "");
  assert.deepEqual(dated.map((item) => [item.type, item.group]), [["period", "Photos · taken in September 2025"], ["photo", "Photos · taken in September 2025"], ["photo", "Photos · taken in September 2025"]]);
});

test("each result names what a tap does and reads its subtitle like the desktop", () => {
  const items = searchItems(buildResults({ query: "blue", volumes, rows, libraries, photos }), "");
  const song = items.find((item) => item.type === "song");
  const episode = items.find((item) => item.type === "episode");
  assert.equal(searchVerb(song), "Play in album");
  assert.equal(searchViewAction(song), "Open album");
  assert.equal(searchVerb(episode, true), "Resume");
  assert.equal(searchViewAction(episode), "Open show");
  assert.equal(searchSubtitle(song), "Miles Davis · Kind of Blue");
  assert.equal(searchSubtitle(episode, { left: "32 min left" }), "The Wild Project · 32 min left");
  assert.equal(searchSubtitle(items.find((item) => item.type === "album")), "Miles Davis · 2 songs");
  assert.equal(searchSubtitle({ type: "folder", id: "a" }, { files: 214 }), "Folder · 214 files");
  assert.equal(searchSubtitle({ type: "file", path: "plans/a.pdf", folder: "Documents", size: 2048 }), "plans · 2.0 KB");
});

test("a tap lands in the result's own view and a long press offers Show in folder", () => {
  const items = searchItems(buildResults({ query: "blue", volumes, rows, libraries, photos }), "");
  const song = items.find((item) => item.type === "song");
  assert.deepEqual(searchLanding(song), { to: "music", route: [{ kind: "albums" }, { kind: "album", id: song.albumId }], play: true }, "a song plays within its album");
  assert.equal(searchLanding(song, "view").play, false, "Open album plays nothing");
  const episode = items.find((item) => item.type === "episode");
  assert.deepEqual(searchLanding(episode), { to: "music", route: [{ kind: "podcasts" }, { kind: "show", id: episode.showId }], play: true }, "an episode resumes in its show");
  const album = items.find((item) => item.type === "album");
  assert.deepEqual(searchLanding(album), { to: "music", route: [{ kind: "albums" }, { kind: "album", id: album.id }], play: false });
  assert.equal(searchLanding(album, "play").play, true, "the Fold pane's Play plays the album");
  assert.deepEqual(searchLanding(items.find((item) => item.type === "artist")).route[1].kind, "artist");
  assert.deepEqual(searchLanding(items.find((item) => item.type === "playlist")).route, [{ kind: "playlists" }, { kind: "playlist", id: library.playlistOrder[0] }]);
  assert.deepEqual(searchLanding({ type: "folder", id: "a" }), { to: "folder" });
  const photo = searchItems(buildResults({ query: "september 2025", volumes, rows, photos }), "").find((item) => item.type === "photo");
  assert.deepEqual(searchLanding(photo), { to: "gallery", focus: { path: "2025/09/sea.jpg", month: "2025-09" } }, "a photo opens the viewer at it in its gallery");
  const period = searchItems(buildResults({ query: "september 2025", volumes, rows, photos }), "").find((item) => item.type === "period");
  assert.deepEqual(searchLanding(period), { to: "gallery", focus: { path: null, month: "2025-09" } });
  const file = searchItems(buildResults({ query: "plan", volumes, rows }), "").find((item) => item.type === "file");
  assert.deepEqual(searchLanding(file), { to: "history" }, "a file keeps file History");
  assert.deepEqual(searchLanding(file, "reveal"), { to: "files", directory: "plans/", focus: "plans/plan.txt" }, "Show in folder opens the parent with the row highlighted");
  assert.deepEqual(searchLanding(song, "reveal"), { to: "files", directory: "Miles Davis/Kind of Blue/", focus: "Miles Davis/Kind of Blue/03 Blue in Green.mp3" });
  assert.deepEqual(searchLanding(album, "reveal"), { to: "files", directory: "Miles Davis/", focus: "Miles Davis/Kind of Blue" }, "an album shows its folder");
  assert.equal(searchCanReveal(photo), false, "a gallery has no file browser on the phone");
  assert.equal(searchCanReveal({ type: "artist" }), false);
});

test("the Folders root has one quiet search button, no Sync now and a pull that runs the full sync", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  const theme = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /searchFieldRow/, "the list has no search field");
  assert.doesNotMatch(theme, /searchFieldRow/);
  assert.match(app, /\{connected && screen === "Folders" && folder && \(\s+<Button\s+iconOnly\s+label="Sync now"/, "only a folder's header keeps Sync now");
  assert.equal(app.match(/label="Sync now"/g).length, 1);
  assert.match(app, /onRefresh=\{\(\) => \{\s+if \(status\.paused\) return;\s+setPulling\(true\);\s+startSync\(true\);\s+\}\}/, "the pull forces a pass and does nothing while paused");
  assert.match(theme, /ghostButton: \{\s+width: g\.touchHeight,\s+height: g\.touchHeight,\s+minHeight: g\.touchHeight,\s+borderWidth: 0,\s+backgroundColor: "transparent",\s+\}/);
  assert.match(components, /ghost \? c\.mute : c\.ink/, "the ghost glyph uses the mute ink");
  assert.match(components, /<PressScale\s+scale=\{!disabled && !busy && !ghost\}/, "a ghost button fills without scaling");
});

test("the phone has one search: the screen, a search button in every header and no folder or library filter", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const overlay = fs.readFileSync(new URL("../apps/mobile/src/GlobalSearch.jsx", import.meta.url), "utf8");
  const library = fs.readFileSync(new URL("../apps/mobile/src/MusicLibrary.jsx", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../apps/mobile/src/replica-store.js", import.meta.url), "utf8");
  assert.match(app, /<GlobalSearch/);
  assert.match(app, /store\.searchRows\(r\.scope, v\.id, tokens\[0\]\)/);
  assert.match(app, /folderLibrary\(r, v\.id\)/, "audio folders answer from their cached library");
  assert.match(app, /cachedGalleryItems\(r\.store, r\.scope, v\.id\)/, "dates match the gallery's cached metadata");
  assert.match(app, /name: "sync", label: "Sync now"/);
  assert.match(app, /\{searchable && !folder && !detail && \(\s+<Button\s+iconOnly\s+ghost\s+label="Search Arca"\s+icon="search"\s+onPress=\{\(\) => setGlobalSearch\(true\)\}/, "Folders, Devices, History and Settings open the one search from a quiet header button");
  assert.match(app, /\{searchable && \(\s+<Button\s+iconOnly\s+ghost\s+label="Search Arca"/, "a folder's header opens the same search");
  for (const local of [/Search files/, /Search this folder/, /musicSearch/, /setMusicSearch/, /searchOpen/, /setSearch\(/]) assert.doesNotMatch(app, local);
  assert.doesNotMatch(library, /search/i, "the library has no search");
  assert.doesNotMatch(overlay, /SCOPES|"All"|"Music"/, "no scope segments");
  assert.doesNotMatch(overlay, /remoteView|interactiveClient|fetch\(/, "search never reads the hub");
  assert.match(overlay, /onLongPress=\{\(\) => hold\(item\)\}/, "a long press opens the sheet");
  assert.match(overlay, /label="Show in folder"/);
  assert.match(overlay, /Backspace/, "Backspace in an empty field removes the type chip");
  assert.match(store, /async searchRows\(/);
  assert.match(overlay, /onForget\(text\)/);
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  assert.match(app, /focus=\{galleryFocus\}\s+onFocused=\{\(\) => setGalleryFocus\(null\)\}/, "a photo result reaches its gallery");
  assert.match(gallery, /const item = focus\.path \? photos\.find\(\(photo\) => photo\.path === focus\.path\) : null;\s+if \(item\) \{\s+actions\.current\.open\(item\);/, "the gallery opens the viewer at the photo");
  assert.match(gallery, /hub\s+\.load\(focus\.month\)/, "and loads the photo's month when it is not on screen yet");
});

test("the phone's stored search finds accented names for plain, accented and multi-word queries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-search-"));
  const db = new DatabaseSync(path.join(root, "store.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new ReplicaStore({
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...values) => db.prepare(sql).run(...values),
    getFirstAsync: async (sql, ...values) => db.prepare(sql).get(...values),
    getAllAsync: async (sql, ...values) => db.prepare(sql).all(...values),
  });
  await store.init();
  for (const [name, rev] of [["Café menu.txt", 1], ["notes.txt", 2], ["menu cafe.md", 3]]) await store.put("s", { volume: "a", path: name, rev, size: 1, hash: `h${rev}` });
  for (const query of ["cafe", "café", "café menu", "CAFÉ"]) {
    const rows = { a: await store.searchRows("s", "a", searchTokens(query).tokens[0]) };
    const found = buildResults({ query, type: "files", volumes: [{ id: "a", name: "Documents" }], rows, limit: 10 });
    assert.deepEqual(found.groups[0]?.rows.map((row) => row.name).sort(), ["Café menu.txt", "menu cafe.md"], query);
  }
});

test("the phone's stored search keeps older plain matches when many newer names are accented", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-mobile-search-"));
  const db = new DatabaseSync(path.join(root, "store.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new ReplicaStore({
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...values) => db.prepare(sql).run(...values),
    getFirstAsync: async (sql, ...values) => db.prepare(sql).get(...values),
    getAllAsync: async (sql, ...values) => db.prepare(sql).all(...values),
  });
  await store.init();
  await store.put("s", { volume: "a", path: "Beatles/Help.mp3", rev: 1, size: 1, hash: "h1" });
  await store.put("s", { volume: "a", path: "Café menu.txt", rev: 2, size: 1, hash: "h2" });
  await store.put("s", { volume: "a", path: "menu cafe.md", rev: 3, size: 1, hash: "h3" });
  db.exec("BEGIN");
  for (let i = 0; i < 2500; i++) await store.put("s", { volume: "a", path: `Canción ${i}.mp3`, rev: 10 + i, size: 1, hash: `c${i}` });
  db.exec("COMMIT");
  const search = async (query) => {
    const rows = { a: await store.searchRows("s", "a", searchTokens(query).tokens[0]) };
    return buildResults({ query, type: "files", volumes: [{ id: "a", name: "Music" }], rows, limit: 10 }).groups[0]?.rows.map((row) => row.name).sort();
  };
  assert.deepEqual(await search("beatles"), ["Help.mp3"]);
  for (const query of ["cafe", "café", "café menu", "CAFÉ"]) assert.deepEqual(await search(query), ["Café menu.txt", "menu cafe.md"], query);
});

test("Show in folder pages the list to the found row and scrolls it into view", async () => {
  const { FIRST_ROWS, REVEAL_ROWS, revealWindow } = await import("../apps/mobile/src/browse.js");
  const entries = Array.from({ length: 20000 }, (_, i) => ({ path: `plans/f${i}.txt` }));
  assert.deepEqual(revealWindow(entries, "plans/f42.txt", FIRST_ROWS), FIRST_ROWS, "a row already shown keeps the page");
  assert.deepEqual(revealWindow(entries, "plans/f180.txt", FIRST_ROWS), { start: 0, end: 200 }, "a later row raises the shown count to include it");
  assert.deepEqual(revealWindow(entries, "plans/f249.txt", FIRST_ROWS), { start: 0, end: 300 });
  assert.deepEqual(revealWindow(entries, null, FIRST_ROWS), FIRST_ROWS);
  assert.deepEqual(revealWindow(entries, "plans/missing.txt", FIRST_ROWS), FIRST_ROWS);
  assert.equal(REVEAL_ROWS, 500);
  const far = revealWindow(entries, "plans/f19999.txt", FIRST_ROWS);
  assert.deepEqual(far, { start: 19900, end: 20000 }, "a row past the cap opens one page around it instead of every row before it");
  assert.ok(far.end - far.start <= REVEAL_ROWS);
  assert.deepEqual(revealWindow(entries, "plans/f12.txt", far), { start: 0, end: 100 }, "a row near the top again starts from the top");
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const pane = fs.readFileSync(new URL("../apps/mobile/src/KeyboardPane.jsx", import.meta.url), "utf8");
  assert.match(app, /setShownRows\(\(shown\) => revealWindow\(visibleEntries, focusPath, shown\)\);\s+\}, \[focusPath, visibleEntries\]\);/);
  assert.match(app, /\.slice\(shownRows\.start, shownRows\.end\)/);
  assert.match(app, /\{shownRows\.start > 0 && \(\s+<Button\s+label="Show earlier files"/, "a window past the cap pages back");
  assert.match(app, /<Reveal key=\{e\.path\} active=\{focusPath === e\.path\}>\s+<Pressable/, "the focused row scrolls itself into view");
  assert.match(pane, /export function Reveal\(\{ active, children \}\)[\s\S]*?position\.measure\(node\.current,[\s\S]*?position\.scrollTo\(/);
});

test("offline, a photo result whose month is not loaded opens from the cached gallery", async () => {
  const { cachedMonthFocus } = await import("../apps/mobile/src/hub-gallery.js");
  const items = [
    { path: "a.jpg", date: "2025-09-21T10:00:00" },
    { path: "b.jpg", date: "2025-09-14T10:00:00" },
    { path: "c.jpg", date: "2024-01-02T10:00:00" },
    { path: "d.jpg", date: null },
  ];
  assert.deepEqual(cachedMonthFocus(items, "b.jpg"), { items: items.slice(0, 2), index: 1 }, "the photo opens among its month");
  assert.deepEqual(cachedMonthFocus(items, "d.jpg"), { items: [items[3]], index: 0 });
  assert.equal(cachedMonthFocus(items, "missing.jpg"), null);
  const gallery = fs.readFileSync(new URL("../apps/mobile/src/FolderGallery.jsx", import.meta.url), "utf8");
  assert.match(gallery, /if \(!online && focus\.path\) \{\s+cachedGalleryItems\(store, scope, volume\)[\s\S]*?const found = cachedMonthFocus\(items, focus\.path\);\s+if \(live\.current && found\)\s+setViewer\(\{ items: found\.items\.map\(shownPhoto\), index: found\.index \}\);/);
});
