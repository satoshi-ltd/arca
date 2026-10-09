import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { homeFromActivity, latestLine, newestCovers, newestImages } from "../apps/mobile/src/home-data.js";

const rows = [
  { volume: "a", path: "x/IMG_1.jpg", rev: 9, created: "2026-10-09T10:00:00Z", author: "fold", deleted: 0 },
  { volume: "b", path: "gone.md", rev: 8, created: "2026-10-09T09:00:00Z", author: "mac", deleted: 1 },
  { volume: "b", path: "notes/brief.md", rev: 7, created: "2026-10-09T08:00:00Z", author: "mac", deleted: 0 },
  { volume: "z", path: "other.md", rev: 6, created: "2026-10-09T07:00:00Z", author: "mac", deleted: 0 },
  { volume: "a", path: "x/IMG_0.jpg", rev: 5, created: "2026-10-08T07:00:00Z", author: "fold", deleted: 0 },
  { volume: "a", path: "x/IMG_older.jpg", rev: 4, created: "2026-10-07T07:00:00Z", author: "fold", deleted: 0 },
];

test("arrivals are the three newest changes of the selected folders and deletions never count", () => {
  const { arrivals, last } = homeFromActivity(rows, ["a", "b"]);
  assert.deepEqual(arrivals.map((r) => r.path), ["x/IMG_1.jpg", "notes/brief.md", "x/IMG_0.jpg"]);
  assert.deepEqual(Object.keys(last).sort(), ["a", "b"], "an unselected folder has no caption");
  assert.equal(last.b.path, "notes/brief.md", "the latest change skips a deletion");
  assert.deepEqual(homeFromActivity(null, ["a"]), { arrivals: [], last: {} });
});

test("the newest four local photos and the newest three distinct covers", () => {
  const files = [1, 2, 3, 4, 5].map((n) => ({ path: `p${n}.jpg`, rev: n })).concat([
    { path: "clip.mp4", rev: 99 },
    { path: "notes.txt", rev: 98 },
    { path: "dir", rev: 97, directory: true },
    { path: "deleted.jpg", rev: 96, deleted: true },
  ]);
  assert.deepEqual(newestImages(files), ["p5.jpg", "p4.jpg", "p3.jpg", "p2.jpg"]);
  assert.deepEqual(newestImages([]), []);
  assert.deepEqual(newestImages([{ path: "a.HEIC", rev: 2 }, { path: "b.jpg", rev: 1 }]), ["b.jpg"], "a format the phone cannot decode is not previewed");
  const library = { tracks: [
    { cover: "c1", added: "2026-01-01" },
    { cover: "c2", added: "2026-03-01" },
    { cover: "c2", added: "2026-03-02" },
    { cover: null, added: "2026-04-01" },
    { cover: "c3", added: "2026-02-01" },
    { cover: "c4", added: "2025-01-01" },
  ] };
  assert.deepEqual(newestCovers(library), ["c2", "c3", "c1"]);
  assert.deepEqual(newestCovers(null), []);
});

test("the caption names the file, the device and the time, or nothing", () => {
  assert.equal(latestLine({ path: "a/b/brief.md", author: "mac", created: "t" }, (id) => `dev-${id}`, () => "2 h ago"), "brief.md · dev-mac · 2 h ago");
  assert.equal(latestLine(undefined, () => "", () => ""), "");
});

test("the phone Folders screen wires the strip, the caption, the previews and the conflict ring", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  assert.match(app, /<ArrivalsStrip/);
  assert.match(app, /latest=\{latestLine\(/);
  assert.match(app, /preview=\{home\.previews\[f\.id\]\}/);
  assert.match(app, /\/v1\/activity\?limit=50&filter=revisions/);
  assert.match(components, /preview\.kind === "photos"/);
  assert.match(components, /s\.homeConflict/);
});
