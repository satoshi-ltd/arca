import test from "node:test";
import assert from "node:assert/strict";
import { cachedFileHistory } from "../packages/daemon/history-cache.js";

const row = (rev, path, extra = {}) => ({ rev, path, size: 10, deleted: 0, author: "m", created: `2026-09-${String(rev).padStart(2, "0")}T00:00:00Z`, ...extra });
function store(windows) {
  const saved = windows.map(({ filter, versions, next = null, updated = 1, version = "g1" }) => ({
    filter,
    version,
    updated,
    value: JSON.stringify({ versions, next }),
  }));
  return { db: { prepare: () => ({ all: () => saved }) } };
}

test("a busy folder's saved file history keeps only the rows the full revisions window covers", () => {
  const busy = [];
  for (let rev = 120; rev > 70; rev--) busy.push(row(rev, rev % 5 === 0 ? "brief.md" : `other-${rev}.txt`));
  const windows = [
    { filter: "revisions", versions: busy, next: 71 },
    { filter: "deleted", versions: [row(66, "brief.md", { deleted: 1 }), row(12, "gone.txt", { deleted: 1 })], next: null },
    { filter: "conflicts", versions: [row(40, "brief.md.conflict-fold-1a2b"), row(9, "brief.md.conflict-mac-9f3a")], next: null },
  ];
  const history = cachedFileHistory(store(windows), "hub", "v1", "brief.md");
  assert.deepEqual(history.versions.map((r) => r.rev), [120, 115, 110, 105, 100, 95, 90, 85, 80, 75], "newest first, nothing older than the revisions window's oldest row");
  assert.equal(history.truncated, true, "older revisions exist on the hub");
  const conflict = cachedFileHistory(store(windows), "hub", "v1", "brief.md.conflict-fold-1a2b");
  assert.deepEqual(conflict.versions.map((r) => r.rev), [40], "a conflict copy reads the conflicts and deleted windows, both complete here");
  assert.equal(conflict.truncated, false);
  const deletions = [
    { filter: "revisions", versions: busy, next: null },
    { filter: "deleted", versions: [row(90, "brief.md", { deleted: 1 }), row(88, "x.txt", { deleted: 1 })], next: 88 },
    { filter: "conflicts", versions: [], next: null },
  ];
  const withOlderDeletions = cachedFileHistory(store(deletions), "hub", "v1", "brief.md");
  assert.deepEqual(withOlderDeletions.versions.map((r) => r.rev), [120, 115, 110, 105, 100, 95, 90], "a partial deleted window bounds the file too, so no deletion is missing between the rows shown");
  assert.equal(withOlderDeletions.truncated, true);
});

test("a quiet folder's saved history is complete and says so", () => {
  const windows = [
    { filter: "revisions", versions: [row(30, "a.txt"), row(20, "b.txt"), row(10, "a.txt")], next: null },
    { filter: "deleted", versions: [row(5, "a.txt", { deleted: 1 })], next: null },
  ];
  const history = cachedFileHistory(store(windows), "hub", "v1", "a.txt");
  assert.deepEqual(history.versions.map((r) => r.rev), [30, 10, 5]);
  assert.equal(history.truncated, false);
});

test("without both windows a file needs, nothing can be trusted to be contiguous", () => {
  const onlyDeleted = [{ filter: "deleted", versions: [row(5, "a.txt", { deleted: 1 })], next: null }];
  assert.deepEqual(cachedFileHistory(store(onlyDeleted), "hub", "v1", "a.txt"), { savedAt: 1, versions: [], truncated: true });
  const onlyRevisions = [{ filter: "revisions", versions: [row(30, "a.txt")], next: null }];
  assert.deepEqual(cachedFileHistory(store(onlyRevisions), "hub", "v1", "a.txt").versions, [], "deletions in between could be missing");
  assert.equal(cachedFileHistory(store(onlyRevisions), "hub", "v1", "a.txt").truncated, true);
  assert.deepEqual(cachedFileHistory(store([]), "hub", "v1", "a.txt"), { savedAt: 0, versions: [], truncated: false });
});

test("windows saved at different folder versions are never combined, and both partial windows bound the file", () => {
  const mixed = [
    { filter: "revisions", versions: [row(120, "a.txt"), row(110, "a.txt"), row(80, "a.txt")], next: null, version: "g2" },
    { filter: "deleted", versions: [], next: null, version: "g1" },
  ];
  assert.deepEqual(cachedFileHistory(store(mixed), "hub", "v1", "a.txt"), { savedAt: 1, versions: [], truncated: true }, "a deletion between two shown rows could be missing");
  const both = [
    { filter: "revisions", versions: [row(120, "a.txt"), row(90, "a.txt"), row(70, "a.txt")], next: 70 },
    { filter: "deleted", versions: [row(100, "a.txt", { deleted: 1 })], next: 95 },
  ];
  const history = cachedFileHistory(store(both), "hub", "v1", "a.txt");
  assert.deepEqual(history.versions.map((r) => r.rev), [120, 100], "the newer of the two partial floors wins");
  assert.equal(history.truncated, true);
});

test("a deleted conflict copy has no content rows in any window, so its saved history is not offered", () => {
  const windows = [
    { filter: "revisions", versions: [row(60, "a.md")], next: null },
    { filter: "deleted", versions: [row(50, "a.md.conflict-fold-1a2b", { deleted: 1 })], next: null },
    { filter: "conflicts", versions: [], next: null },
  ];
  assert.deepEqual(cachedFileHistory(store(windows), "hub", "v1", "a.md.conflict-fold-1a2b"), { savedAt: 1, versions: [], truncated: true });
});

test("an offline page respects the before cursor so loading more never repeats rows", () => {
  const windows = [
    { filter: "revisions", versions: [row(30, "a.txt"), row(20, "a.txt"), row(10, "a.txt")], next: null },
    { filter: "deleted", versions: [], next: null },
  ];
  assert.deepEqual(cachedFileHistory(store(windows), "hub", "v1", "a.txt", 20).versions.map((r) => r.rev), [10]);
  assert.deepEqual(cachedFileHistory(store(windows), "hub", "v1", "a.txt").versions.map((r) => r.rev), [30, 20, 10]);
});
