import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildResults, forgetSearch, fold, rememberSearch, searchTokens } from "../apps/mobile/src/search-local.js";

const volumes = [{ id: "a", name: "Documents" }, { id: "b", name: "Holiday photos" }];
const file = (path, rev, extra = {}) => ({ path, rev, size: 10, ...extra });
const rows = {
  a: [file("plans/site-plan.pdf", 3), file("plans/plan.txt", 5), file("old/planet.md", 4), file("deep/unplanned.txt", 2), file("gone-plan.txt", 9, { deleted: 1 }), file("folder", 8, { directory: true })],
  b: [file("2026/plan-b.jpg", 6), file("tracks/Planet Earth.mp3", 7), file("Ñandú.txt", 1)],
};
const tracks = { b: [{ path: "tracks/Planet Earth.mp3", title: "Planet Earth", artist: "Duran Duran", album: "Duran Duran", cover: "k".repeat(64) }] };

test("phone search ranks names across folders and groups them like the desktop palette", () => {
  const all = buildResults({ query: "plan", volumes, rows, tracks });
  assert.deepEqual(all.files.map((r) => r.name), ["plan.txt", "planet.md", "site-plan.pdf", "unplanned.txt"]);
  assert.deepEqual(all.photos.map((r) => [r.name, r.folder, r.kind]), [["plan-b.jpg", "Holiday photos", "image"]]);
  assert.deepEqual(all.music.map((r) => [r.title, r.artist, r.album]), [["Planet Earth", "Duran Duran", "Duran Duran"]]);
  assert.deepEqual(all.counts, { files: 4, photos: 1, music: 1, folders: 0 });
  assert.ok(!JSON.stringify(all).includes("gone-plan"), "deleted files never match");
  assert.equal(JSON.stringify(all).includes('"folder"'), true);
});

test("a track is found by its tags even when the file name does not contain the word", () => {
  const byArtist = buildResults({ query: "duran", scope: "music", volumes, rows: { a: [], b: [] }, tracks });
  assert.deepEqual(byArtist.music.map((r) => r.title), ["Planet Earth"], "the library supplies the candidate when SQL matched nothing on the path");
  const both = buildResults({ query: "duran", volumes, rows: { b: [file("tracks/Planet Earth.mp3", 7)] }, tracks });
  assert.equal(both.music.length, 1, "a track already matched by path is not duplicated");
});

test("scopes, limits, folder matches, words and non-ASCII case", () => {
  assert.deepEqual(buildResults({ query: "holiday", volumes, rows, tracks }).folders.map((r) => r.name), ["Holiday photos"]);
  assert.deepEqual(buildResults({ query: "plan", scope: "files", volumes, rows, tracks }).photos, []);
  assert.deepEqual(buildResults({ query: "plan", scope: "files", volumes, rows, tracks }).folders, [], "folders appear only under All");
  const capped = buildResults({ query: "plan", scope: "files", volumes, rows, tracks, limit: 2 });
  assert.equal(capped.files.length, 2);
  assert.equal(capped.counts.files, 4);
  assert.deepEqual(buildResults({ query: "site pla", volumes, rows, tracks }).files.map((r) => r.name), ["site-plan.pdf"]);
  assert.deepEqual(buildResults({ query: "ÑANDÚ", volumes, rows, tracks }).files.map((r) => r.name), ["Ñandú.txt"]);
  assert.deepEqual(buildResults({ query: "duran", scope: "music", volumes, rows, tracks }).music.length, 1, "a track matches by artist");
  assert.deepEqual(buildResults({ query: "  ", volumes, rows, tracks }).counts, { folders: 0, files: 0, photos: 0, music: 0 });
  assert.deepEqual(searchTokens("  Site  PLAN ").tokens, ["site", "plan"]);
  assert.equal(fold("É"), "é");
});

test("recent searches keep five, newest first, without duplicates, and forget one", () => {
  let list = [];
  for (const text of ["a", "b", "c", "d", "e", "f", "c", "  "]) list = rememberSearch(list, text);
  assert.deepEqual(list, ["c", "f", "e", "d", "b"]);
  assert.deepEqual(forgetSearch(list, "f"), ["c", "e", "d", "b"]);
});

test("the phone wires the search field, the overlay, the local store query and the actions", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const overlay = fs.readFileSync(new URL("../apps/mobile/src/GlobalSearch.jsx", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../apps/mobile/src/replica-store.js", import.meta.url), "utf8");
  assert.match(app, /accessibilityLabel="Search Arca"/);
  assert.match(app, /<GlobalSearch/);
  assert.match(app, /store\.searchRows\(r\.scope, v\.id, tokens\[0\]\)/);
  assert.match(app, /name: "sync", label: "Sync now"/);
  assert.doesNotMatch(overlay, /remoteView|interactiveClient|fetch\(/, "search never reads the hub");
  assert.match(store, /async searchRows\(/);
  assert.match(overlay, /onForget\(text\)/);
});
