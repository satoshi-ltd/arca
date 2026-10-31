import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deleteVideo } from "../apps/mobile/src/confirm-copy.js";
import { deleteChoices, normalizeLibrary, routeAfterDeletion, survivesDeletion, videoSheet } from "../apps/mobile/src/video-library.js";
import { deleteNotice, deleteVideos } from "../apps/mobile/src/video-sync.js";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");
const app = read("App.jsx");
const screen = read("VideoLibrary.jsx");

const episode = (n, season = 1) => ({ id: `e${season}${n}`, path: `Andor/S${season}E${n}.mkv`, rev: 10 + n, episode: n, title: `Ep ${n}` });
const library = () =>
  normalizeLibrary({
    version: "1",
    movies: [{ id: "m1", path: "Heat.mkv", rev: 7, title: "Heat" }],
    shows: [{ id: "s1", title: "Andor", seasons: [{ season: 1, episodes: [episode(1), episode(2)] }, { season: 2, episodes: [episode(1, 2)] }] }],
  });

test("library rows carry the hub's rev for movies and episodes", () => {
  const lib = library();
  assert.equal(lib.items.get("m1").rev, 7);
  assert.equal(lib.items.get("e12").rev, 12);
});

test("deletion choices cover movie, shown season, show and episode", () => {
  const lib = library();
  assert.deepEqual(deleteChoices(lib.items.get("m1")).map((c) => c.label), ["Delete movie…"]);
  const show = lib.items.get("s1");
  const choices = deleteChoices(show, 2);
  assert.deepEqual(choices.map((c) => c.label), ["Delete season 2…", "Delete show…"]);
  assert.equal(choices[0].items.length, 1);
  assert.equal(choices[1].items.length, 3);
  assert.deepEqual(deleteChoices(show, 9).map((c) => c.name), ["delete-show"]);
  assert.deepEqual(deleteChoices(lib.items.get("e11")).map((c) => c.label), ["Delete episode…"]);
  assert.equal(videoSheet({ kind: "video-actions", item: lib.items.get("e11"), showTitle: "Andor" }).subtitle, "Andor · S1 · E1");
});

test("the confirmation names the title, counts the files and warns it cannot be undone", () => {
  const items = Array.from({ length: 10 }, (_, i) => episode(i + 1));
  const season = deleteVideo({ title: "Andor", season: 1, unit: "episode", items });
  assert.equal(season.title, "Delete “Andor” season 1?");
  assert.equal(season.message, "Removes 10 episodes from the hub for every device and cannot be undone: Movies & TV keeps no copies or history. The downloads on this device go with it.");
  assert.equal(season.label, "Delete 10 episodes");
  assert.equal(season.destructive, true);
  assert.equal(deleteVideo({ title: "Andor", unit: "episode", items }).title, "Delete “Andor”?");
  const one = deleteVideo({ title: "1. Kassa", unit: "episode", items: [items[0]] });
  assert.equal(one.message, "Removes 1 episode from the hub for every device and cannot be undone: Movies & TV keeps no copies or history. The download on this device goes with it.");
  assert.equal(one.label, "Delete 1 episode");
  const movie = deleteVideo({ title: "Heat", unit: "movie", items: [items[0]] });
  assert.equal(movie.message, "Removes the file from the hub for every device and cannot be undone: Movies & TV keeps no copies or history. The download on this device goes with it.");
  assert.equal(movie.label, "Delete movie");
});

test("files are deleted in order with their rev, a refusal does not stop the rest, and downloads of the deleted ones go", async () => {
  const items = [episode(1), episode(2), episode(3)];
  const calls = [];
  const removed = [];
  const client = {
    api: async (route, body) => {
      calls.push([route, body]);
      if (body.path === items[1].path) throw Object.assign(new Error("409 stale"), { code: "http_409" });
    },
  };
  const result = await deleteVideos({ client, volume: "v1", items, removeDownloads: async (rows) => removed.push(...rows) });
  assert.deepEqual(calls, items.map((i) => ["/v1/delete-file", { volume: "v1", path: i.path, rev: i.rev }]));
  assert.deepEqual(result.deleted.map((i) => i.path), [items[0].path, items[2].path]);
  assert.deepEqual(result.failed, [items[1]]);
  assert.deepEqual(removed, result.deleted);
  assert.equal(deleteNotice(result, "episode"), "Deleted 2 of 3 episodes. 1 could not be removed.");
  assert.equal(deleteNotice({ deleted: items, failed: [] }, "episode"), "3 episodes deleted.");
  assert.equal(deleteNotice({ deleted: [items[0]], failed: [] }, "episode"), "1 episode deleted.");
  assert.equal(deleteNotice({ deleted: [items[0]], failed: [] }, "movie"), "Movie deleted.");
});

test("an unreachable hub changes nothing and is raised for the usual failure notice; midway it stops", async () => {
  const items = [episode(1), episode(2)];
  const removed = [];
  const down = Object.assign(new Error("Network request failed"), { hubUnavailable: true });
  await assert.rejects(
    deleteVideos({ client: { api: async () => { throw down; } }, volume: "v1", items, removeDownloads: async (rows) => removed.push(...rows) }),
    down,
  );
  assert.deepEqual(removed, []);
  let n = 0;
  const result = await deleteVideos({
    client: { api: async () => { if (++n > 1) throw down; } },
    volume: "v1",
    items,
    removeDownloads: async (rows) => removed.push(...rows),
  });
  assert.deepEqual(result.deleted, [items[0]]);
  assert.deepEqual(result.failed, [items[1]]);
  assert.deepEqual(removed, [items[0]]);
});

test("a title page survives only while something of it remains", () => {
  const lib = library();
  const show = lib.items.get("s1");
  assert.equal(survivesDeletion(show, [lib.items.get("e11"), lib.items.get("e12")]), true);
  assert.equal(survivesDeletion(show, [lib.items.get("e11"), lib.items.get("e12"), lib.items.get("e21")]), false);
  assert.equal(survivesDeletion(lib.items.get("m1"), [lib.items.get("m1")]), false);
});

test("a finished delete leaves the route alone unless it still shows the deleted title", () => {
  const lib = library();
  const home = { kind: "home" };
  const andor = [home, { kind: "title", id: "s1" }];
  const heat = [home, { kind: "title", id: "m1" }];
  const show = [lib.items.get("e11"), lib.items.get("e12"), lib.items.get("e21")];
  assert.deepEqual(routeAfterDeletion(andor, lib, show), [home]);
  assert.equal(routeAfterDeletion(heat, lib, show), heat, "the user moved on to another title");
  assert.deepEqual(routeAfterDeletion([home], lib, show), [home], "the user went back to the shelves");
  assert.equal(routeAfterDeletion(andor, lib, show.slice(0, 2)), andor, "the show keeps a season");
  assert.equal(routeAfterDeletion(andor, null, show), andor);
});

test("the sheet, the episode actions and the confirmation are wired to the hub client and the download removal", () => {
  assert.match(screen, /<View style=\{s\.destructiveActionGroup\}>[\s\S]*?danger[\s\S]*?act\(choice\.name\)/);
  assert.match(screen, /\{!!more && \(\s+<Pressable accessibilityRole="button" accessibilityLabel="Episode actions" hitSlop=\{4\} onPress=\{\(\) => more\(ep\)\} style=\{\(\{ pressed \}\) => \[s\.musicRowAction, pressed && s\.musicPressed\]\}>\s+<Icon name="more" size=\{20\} color=\{c\.mute\} \/>/, "phone and Fold rows show the music row ⋯");
  assert.match(screen, /onLongPress=\{more \? \(\) => more\(ep\) : undefined\}/);
  assert.match(screen, /more=\{\(entry\) => more\(entry, season\.season, item\.title\)\}/);
  assert.match(app, /confirm\(confirmCopy\.deleteVideo\(choice\), \(\) =>\s+run\(/);
  assert.match(app, /deleteVideos\(\{ client, volume, items: choice\.items, removeDownloads: \(rows\) => removeDownloads\(volume, rows\) \}\)/);
  assert.match(app, /setVideoRoute\(\(route\) => routeAfterDeletion\(route, shownVideo\?\.library, result\.deleted\)\);/, "the route is read when the delete finishes, not when it started");
  assert.match(app, /\{ hubOnly: true \},\s+\),\s+\);\s+\}\s+function videoAction/);
});

test("an episode's sheet orders watched, its download action and Delete episode… for every download state", async () => {
  const { downloadAction } = await import("../apps/mobile/src/video-downloads.js");
  const { titleActions } = await import("../apps/mobile/src/video-library.js");
  const ep = library().items.get("e11");
  const sheet = (row) => [...titleActions(ep, downloadAction(row)), ...deleteChoices(ep).map((c) => c.name)];
  assert.deepEqual(sheet(null), ["watched", "download", "delete-episode"]);
  assert.deepEqual(sheet({ state: "queued", running: true, done: 1, size: 2 }), ["watched", "cancel-download", "delete-episode"]);
  assert.deepEqual(sheet({ state: "waiting", done: 0, size: 2 }), ["watched", "cancel-download", "delete-episode"]);
  assert.deepEqual(sheet({ state: "done", done: 2, size: 2 }), ["watched", "remove-download", "delete-episode"]);
  assert.deepEqual(sheet({ state: "stale", done: 2, size: 2 }), ["watched", "download", "remove-download", "delete-episode"], "an outdated copy downloads again or leaves the phone");
  assert.deepEqual(sheet({ state: "failed", done: 1, size: 2 }), ["watched", "download", "remove-download", "delete-episode"], "a failed partial retries or leaves the phone");
  assert.match(app, /if \(name === "remove-download" \|\| name === "cancel-download"\) \{\s+dropDownloads\(volume, downloadTargets\(item\)\);/);
});
