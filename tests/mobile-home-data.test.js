import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { homeFromActivity } from "../apps/mobile/src/home-data.js";

const rows = [
  { volume: "a", path: "x/IMG_1.jpg", rev: 9, created: "2026-10-09T10:00:00Z", author: "fold", deleted: 0 },
  { volume: "b", path: "gone.md", rev: 8, created: "2026-10-09T09:00:00Z", author: "mac", deleted: 1 },
  { volume: "b", path: "notes/brief.md", rev: 7, created: "2026-10-09T08:00:00Z", author: "mac", deleted: 0 },
  { volume: "z", path: "other.md", rev: 6, created: "2026-10-09T07:00:00Z", author: "mac", deleted: 0 },
  { volume: "a", path: "x/IMG_0.jpg", rev: 5, created: "2026-10-08T07:00:00Z", author: "fold", deleted: 0 },
  { volume: "a", path: "x/IMG_older.jpg", rev: 4, created: "2026-10-07T07:00:00Z", author: "fold", deleted: 0 },
];

test("arrivals are the three newest changes of the selected folders and deletions never count", () => {
  const { arrivals } = homeFromActivity(rows, ["a", "b"]);
  assert.deepEqual(arrivals.map((r) => r.path), ["x/IMG_1.jpg", "notes/brief.md", "x/IMG_0.jpg"]);
  assert.deepEqual(homeFromActivity(null, ["a"]), { arrivals: [] });
});

test("the phone Folders screen wires the strip and the conflict ring, with type icons, no previews and no last file", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
  assert.match(app, /<ArrivalsStrip/);
  assert.doesNotMatch(app, /latestLine|homeLatest/);
  assert.doesNotMatch(app, /previews/, "a folder row never shows file content");
  assert.match(app, /\/v1\/activity\?limit=50&filter=revisions/);
  assert.doesNotMatch(components, /homeMosaic|homeStack/);
  assert.match(components, /s\.homeConflict/);
});
