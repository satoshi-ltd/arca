import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { hubFolderLibrary } from "../apps/mobile/src/music-sync.js";
import { albumKey } from "../apps/mobile/src/music-library.js";
import {
  emptyFavorites,
  favoriteCaption,
  favoriteExists,
  favoriteKey,
  favoriteRoute,
  favoritesSettled,
  isFavorite,
  readFavorites,
  reconcileFavorites,
  sortFavorites,
  staleFavorites,
  toggleFavorite,
  withoutFavorites,
} from "../apps/mobile/src/favorites.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");
const docs = { id: "v1", name: "documents" };
const music = { id: "v2", name: "music" };
const invoices = { folder: "v1", kind: "directory", target: "work/invoices", label: "invoices" };
const blue = { folder: "v2", kind: "album", target: "a1", label: "Kind of Blue", cover: null };

test("syncing folders never adds a favorite, and leaving a folder drops its entries", () => {
  const empty = emptyFavorites();
  assert.equal(reconcileFavorites(empty, [docs, music]), empty, "synced folders are not favorites until pinned");
  const pinned = toggleFavorite(toggleFavorite(toggleFavorite(empty, { folder: "v1", kind: "folder", target: "", label: "documents" }), invoices), blue);
  assert.equal(reconcileFavorites(pinned, [docs, music]), pinned);
  const left = reconcileFavorites(pinned, [music]);
  assert.deepEqual(left.items.map(favoriteKey), [favoriteKey(blue)], "a folder that stops syncing drops its pinned folder and places");
  assert.equal(reconcileFavorites(left, [music, docs]), left, "syncing it again adds nothing back");
});

test("pinning toggles any entry and survives invalid storage", () => {
  const folder = { folder: "v1", kind: "folder", target: "", label: "documents" };
  const pinned = toggleFavorite(toggleFavorite(toggleFavorite(emptyFavorites(), folder), invoices), blue);
  assert.ok(isFavorite(pinned, { folder: "v1", kind: "directory", target: "work/invoices" }));
  assert.ok(isFavorite(pinned, { folder: "v1", kind: "folder", target: "" }), "a whole folder pins like any place");
  assert.equal(isFavorite(toggleFavorite(pinned, invoices), invoices), false);
  assert.deepEqual(readFavorites(null), emptyFavorites());
  assert.deepEqual(readFavorites({ items: [invoices, invoices, { kind: "nope" }] }), { items: [invoices] });
  const clean = { items: [invoices] };
  assert.equal(readFavorites(clean), clean);
});

test("favorites caption where each place lives, route to it and notice a missing target", () => {
  assert.equal(favoriteCaption(invoices, "documents"), "documents › work");
  assert.equal(favoriteCaption({ ...invoices, target: "invoices" }, "documents"), "documents");
  assert.equal(favoriteCaption(blue, "music"), "Album · music");
  assert.equal(favoriteCaption({ ...blue, kind: "show" }, "podcasts"), "Show · podcasts");
  assert.deepEqual(favoriteRoute(invoices), { to: "files", directory: "work/invoices/" });
  assert.deepEqual(favoriteRoute(blue), { to: "music", route: [{ kind: "albums" }, { kind: "album", id: "a1" }] });
  assert.deepEqual(favoriteRoute({ kind: "show", target: "s1" }).route, [{ kind: "podcasts" }, { kind: "show", id: "s1" }]);
  assert.deepEqual(favoriteRoute({ kind: "artist", target: "r1" }).route, [{ kind: "artists" }, { kind: "artist", id: "r1" }]);
  const library = { artists: [{ id: "r1" }], albums: new Map([["a1", {}]]), playlists: new Map(), shows: new Map([["s1", {}]]) };
  assert.equal(favoriteExists(blue, library), true);
  assert.equal(favoriteExists({ ...blue, target: "renamed" }, library), false);
  assert.equal(favoriteExists({ kind: "playlist", target: "p" }, library), false);
  assert.equal(favoriteExists({ kind: "artist", target: "r1" }, library), true);
});

test("a pinned sub-folder exists while it or anything under it is in the local index", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new ReplicaStore({
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...values) => db.prepare(sql).run(...values),
    getFirstAsync: async (sql, ...values) => db.prepare(sql).get(...values),
    getAllAsync: async (sql, ...values) => db.prepare(sql).all(...values),
  });
  await store.init();
  await store.put("s", { volume: "v1", path: "work/invoices/a.pdf" });
  await store.put("s", { volume: "v1", path: "work/old/b.pdf", deleted: true });
  await store.put("s", { volume: "v1", path: "work/invoices-2026" });
  assert.equal(await store.hasPath("s", "v1", "work/invoices"), true);
  assert.equal(await store.hasPath("s", "v1", "work"), true);
  assert.equal(await store.hasPath("s", "v1", "work/old"), false, "only deleted rows remain");
  assert.equal(await store.hasPath("s", "v1", "work/invoice"), false, "a name prefix is not a parent");
  assert.equal(await store.hasPath("s", "v2", "work/invoices"), false);
  db.close();
});

test("the phone pins places in Favorites and the Fold opens them from a drawer", () => {
  const app = read("App.jsx");
  const favorites = read("Favorites.jsx");
  const components = read("components.jsx");
  const library = read("MusicLibrary.jsx");
  const root = app.slice(app.indexOf("<FavoritesSection"), app.indexOf("ON HUB · NOT SELECTED"));
  assert.match(root, /items=\{shownFavorites\}[\s\S]*\{folderSections\(folderRows\.map\(\(row\) => row\.item\), folderKind\)/, "Favorites sits before the folder sections and holds every pinned entry");
  assert.match(root, /onLongPress=\{\(\) =>\s+favoriteSheet\(\s+\{ folder: f\.id, kind: "folder", target: "", label: f\.name \},/, "a folder row pins on long press on phone and Fold alike");
  assert.match(app, /const key = `favorites:\$\{r\.scope\}`;/, "favorites live in the app's own storage");
  assert.doesNotMatch(app, /api\([^)]*favorites/i, "favorites are never sent to the hub");
  assert.match(app, /reconcileFavorites\(value, folders\.filter\(\(f\) => f\.selected\)\)/);
  assert.doesNotMatch(app + favorites, /more on hub|openHub|seen/, "no row for the hub's other folders and no folder bookkeeping");
  assert.match(favorites, /if \(!rows\.length\) return null;/, "the phone section hides when empty");
  assert.match(favorites, /\{rows\.length > 0 && \(\s+<ScrollView[\s\S]*?<SectionHead/, "the drawer's Favorites list hides when empty");
  assert.match(favorites, /<Text numberOfLines=\{1\} style=\{\[s\.navLabel, s\.flex\]\}>\s+\{label\}/, "drawer favorites use the destinations' label type");
  assert.match(app, /\{wide && \(\s+<FavoritesDrawer/, "only the Fold has the drawer");
  assert.match(app, /onFavorites=\{onboarding \? undefined : \(\) => setFavoritesOpen\(true\)\}/);
  assert.match(components, /accessibilityLabel="Show favorites"[\s\S]*?<Icon name="panel-left-open"/);
  assert.match(app, /kind: "directory", target: e\.path, label: e\.label/, "a sub-folder row pins on long press");
  assert.match(app, /isFavorite\(favorites, shownSheet\.entry\) \? "Remove from Favorites" : "Add to Favorites"/);
  assert.match(app, /withoutFavorites\(value, missing\)/, "a target that disappears leaves Favorites");
  assert.match(favorites, /rows\.slice\(0, PHONE_FAVORITES\)/);
  assert.match(favorites, /Show all/);
  assert.doesNotMatch(favorites, /moveUp|moveDown|grip-vertical|PanResponder|Reorder|\bmove\(/, "no manual reordering: Edit only removes");
  assert.doesNotMatch(app, /moveFavorite/);
  assert.match(favorites, /<Icon name="circle-minus" color=\{c\.danger\} \/>/);
  for (const kind of ["artist", "playlist", "show"]) assert.match(library, new RegExp(`hold\\("${kind}"`), `${kind} pins on long press`);
  assert.match(library, /hold\("album", album\.id, album\.title, album\.cover\)/);
  assert.match(read("theme.js"), /drawer: \{\s+position: "absolute",\s+top: 0,\s+bottom: 0,\s+left: 0,\s+width: 280,/);
});

test("favorites order themselves like Folders: folders, photos, then audio, alphabetical inside each kind", () => {
  const kinds = { v1: "folders", v2: "audio", v3: "photos", v4: "folders" };
  const entries = [
    { folder: "v2", kind: "show", target: "s1", label: "The Wild Project" },
    { folder: "v1", kind: "folder", target: "", label: "documents" },
    { folder: "v3", kind: "directory", target: "2024/Trips", label: "Trips" },
    { folder: "v2", kind: "folder", target: "", label: "music" },
    { folder: "v4", kind: "folder", target: "", label: "Notes" },
    { folder: "v1", kind: "directory", target: "work/invoices", label: "Ínvoices" },
    { folder: "v3", kind: "folder", target: "", label: "camera" },
    { folder: "v2", kind: "album", target: "a1", label: "Kind of Blue" },
    { folder: "v9", kind: "folder", target: "", label: "Archive" },
  ];
  const sorted = sortFavorites(entries, (entry) => kinds[entry.folder], (entry) => entry.label);
  assert.deepEqual(sorted.map((entry) => entry.label), [
    "Archive",
    "documents",
    "Ínvoices",
    "Notes",
    "camera",
    "Trips",
    "Kind of Blue",
    "music",
    "The Wild Project",
  ], "a place inside a folder joins its folder's kind; case and accents never split the alphabet; an unknown folder reads as a folder");
  assert.deepEqual(entries.map((entry) => entry.label)[0], "The Wild Project", "the stored list is left as pinned");
  const app = read("App.jsx");
  assert.match(app, /const shownFavorites = sortFavorites\(\s+favorites\.items,[\s\S]*?return f \? folderKind\(f\) : "folders";[\s\S]*?\(entry\) => describeFavorite\(entry\)\.label,/);
  assert.match(app, /<FavoritesSection\s+items=\{shownFavorites\}/, "the phone section");
  assert.match(app, /select=\{selectTab\}\s+items=\{shownFavorites\}/, "and the Fold drawer show the same order");
  assert.match(app, /const folderKind = \(f\) => \(galleryFolder\(f\) \? "photos" : isMusicFolder\(catalog, f\.id\) \? "audio" : "folders"\);/, "the same kinds as the Folders sections");
});

test("the phone orders favorites and folder sections exactly as the desktop does", async () => {
  const desktop = await import("../apps/desktop/src/favorite-order.js");
  const { folderSections, nameOrder } = await import("../apps/mobile/src/home-data.js");
  const volumes = [
    { id: "v1", name: "documents" },
    { id: "v2", name: "Música", music: true },
    { id: "v3", name: "camera", gallery: true },
    { id: "v4", name: "Notes 10" },
    { id: "v5", name: "notes 9" },
  ];
  const kind = (volume) => (volume?.gallery ? "photos" : volume?.music ? "audio" : "folders");
  const items = [
    { folder: "v2", kind: "show", target: "s1", label: "the Wild Project" },
    { folder: "v4", kind: "folder", target: "", label: "stale label" },
    { folder: "v3", kind: "directory", target: "Trips", label: "Trips" },
    { folder: "v1", kind: "directory", target: "a/Éclair", label: "Éclair" },
    { folder: "v5", kind: "folder", target: "", label: "notes 9" },
    { folder: "v2", kind: "album", target: "a1", label: "abbey road" },
    { folder: "v1", kind: "directory", target: "b/eclair", label: "eclair" },
    { folder: "v9", kind: "folder", target: "", label: "gone" },
  ];
  const byId = new Map(volumes.map((volume) => [volume.id, volume]));
  const phone = sortFavorites(
    items,
    (entry) => kind(byId.get(entry.folder)),
    (entry) => (entry.kind === "folder" ? (byId.get(entry.folder)?.name ?? entry.label) : entry.label),
  );
  assert.deepEqual(phone, desktop.favoriteOrder(items, volumes).map((index) => items[index]));
  for (const [a, b] of [["a", "B"], ["É", "e"], ["Notes 9", "notes 10"], ["x", "x"]])
    assert.equal(Math.sign(nameOrder(a, b)), Math.sign(desktop.nameOrder(a, b)), `${a} vs ${b}`);
  const sections = folderSections(volumes, kind);
  assert.deepEqual(sections.find((section) => section.kind === "folders").folders.map((volume) => volume.name), ["documents", "notes 9", "Notes 10"], "folders sort by name like the desktop's sections");
});

test("an album whose tracks are all still downloading keeps its pin, and one the hub no longer lists is removed", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new ReplicaStore({
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...values) => db.prepare(sql).run(...values),
    getFirstAsync: async (sql, ...values) => db.prepare(sql).get(...values),
    getAllAsync: async (sql, ...values) => db.prepare(sql).all(...values),
  });
  await store.init();
  const track = { path: "Miles Davis/Kind of Blue/01 So What.mp3", hash: "a".repeat(64), title: "So What", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1 };
  await store.saveMusicLibrary("s", "v2", { version: "1", tracks: [track] });
  const replica = {
    scope: "s",
    store,
    files: { work: (...parts) => parts.join("/"), exists: async () => false, text: async () => "", listNames: async () => [], stat: async () => null },
  };
  const album = { folder: "v2", kind: "album", target: albumKey("v2", track), label: "Kind of Blue" };
  const gone = { ...album, target: "album:gone", label: "Gone" };
  const lookups = { hasPath: async () => true, library: (id) => hubFolderLibrary(replica, id) };
  const folders = [{ id: "v2", completed: "2026-10-01" }];
  const pending = await hubFolderLibrary(replica, "v2");
  assert.equal(pending.pending, 1);
  assert.ok(pending.library.albums.has(album.target), "the hub's library holds the album before its tracks arrive");
  assert.deepEqual(await staleFavorites([album, gone], folders, lookups), [favoriteKey(gone)], "a pending track keeps only its own album; a target the hub no longer lists goes even while a track never arrives");
  await store.put("s", { volume: "v2", path: track.path, hash: track.hash, rev: 1, size: 1 });
  assert.deepEqual(await staleFavorites([album, gone], folders, lookups), [favoriteKey(gone)]);
  const app = read("App.jsx");
  assert.match(app, /while \(r\.active\) await r\.active\.catch\(\(\) => \{\}\);\s+if \(!active \|\| !favoritesSettled\(r\)\) return;\s+const missing = await staleFavorites\(/, "a running sync never prunes");
  assert.match(app, /if \(active && missing\.length && favoritesSettled\(r\)\) await changeFavorites/);
});

test("favorites are pruned only when no run is active and the hub is answering", () => {
  const idle = { active: null, busy: false, moreFolderWork: false, hubUnavailable: false, holdingOffline: false };
  assert.equal(favoritesSettled(idle), true);
  assert.equal(favoritesSettled(null), false);
  for (const [key, value] of [["active", Promise.resolve()], ["busy", true], ["moreFolderWork", true], ["hubUnavailable", true], ["holdingOffline", true]])
    assert.equal(favoritesSettled({ ...idle, [key]: value }), false, key);
});

test("a folder row offers Add to Favorites and Remove from Favorites to screen readers", () => {
  const app = read("App.jsx");
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("export function FolderRow("), components.indexOf("const TABS"));
  assert.match(row, /accessibilityActions=\{onFavorite \? \[\{ name: "favorite", label: favorite \? "Remove from Favorites" : "Add to Favorites" \}\] : undefined\}/);
  assert.match(row, /onAccessibilityAction=\{onFavorite \? \(event\) => event\.nativeEvent\.actionName === "favorite" && onFavorite\(\) : undefined\}/);
  assert.match(
    read("App.jsx"),
    /onAccessibilityAction=\{\(event\) => \{\s+const action = event\.nativeEvent\.actionName;\s+if \(action === "preview" && !e\.directory\) setSheet\(\{ kind: "peek", entry: e \}\);\s+else if \(action === "favorite" && e\.directory\)\s+toggleFavoriteEntry\(/,
    "a file row runs only the action the screen reader named",
  );
  assert.match(app, /favorite=\{isFavorite\(favorites, \{ folder: f\.id, kind: "folder", target: "" \}\)\}\s+onFavorite=\{\(\) => toggleFavoriteEntry\(\{ folder: f\.id, kind: "folder", target: "", label: f\.name \}\)\}/);
});

test("the Fold drawer closes when the screen folds and ignores touches while it leaves", () => {
  const app = read("App.jsx");
  const favorites = read("Favorites.jsx");
  assert.match(app, /useEffect\(\(\) => \{\s+if \(!wide\) setFavoritesOpen\(false\);\s+\}, \[wide\]\);/);
  const drawer = favorites.slice(favorites.indexOf("export function FavoritesDrawer("));
  assert.match(drawer, /<View style=\{s\.modalRoot\} pointerEvents=\{visible \? "auto" : "none"\}>/);
});
