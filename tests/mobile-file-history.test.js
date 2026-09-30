import test from "node:test";
import assert from "node:assert/strict";
import { offlineFileHistory, sameDetail } from "../apps/mobile/src/file-history.js";

const saved = { rev: 5, size: 12, deleted: 0 };
const entry = { path: "a.txt", mtime: Date.UTC(2026, 8, 30, 10) };
const row = (rev) => ({ rev, size: 1, created: "2026-09-29T00:00:00.000Z", deleted: 0 });

test("online or without a local row the saved history is shown unchanged", () => {
  const page = { versions: [row(4)], next: null };
  assert.deepEqual(offlineFileHistory(page, null, entry), { versions: page.versions, currentRev: 4 });
  assert.deepEqual(offlineFileHistory({ ...page, offline: true }, null, entry), { versions: page.versions, currentRev: 4 });
  assert.deepEqual(offlineFileHistory(page, saved, entry), { versions: page.versions, currentRev: 5 });
});

test("offline the phone's own row leads when the saved window lacks it or is older", () => {
  const empty = offlineFileHistory({ offline: true, versions: [], next: null }, saved, entry);
  assert.equal(empty.versions.length, 1);
  assert.deepEqual(
    { rev: empty.versions[0].rev, local: empty.versions[0].local, size: empty.versions[0].size },
    { rev: 5, local: true, size: 12 },
  );
  assert.equal(empty.versions[0].created, "2026-09-30T10:00:00.000Z");
  assert.equal(empty.currentRev, 5);
  const older = offlineFileHistory({ offline: true, versions: [row(4), row(3)], next: null }, saved, entry);
  assert.deepEqual(older.versions.map((version) => version.rev), [5, 4, 3]);
  const current = offlineFileHistory({ offline: true, versions: [row(5), row(4)], next: null }, saved, entry);
  assert.deepEqual(current.versions.map((version) => version.rev), [5, 4], "a saved window that already has the revision is not duplicated");
  assert.equal(current.versions[0].local, undefined);
});

test("the phone's own row needs the file to exist on the phone and reports that file's size and date", () => {
  const page = { offline: true, versions: [row(4)], next: null };
  assert.deepEqual(offlineFileHistory(page, saved, null), { versions: page.versions, currentRev: 5 }, "no file on the phone, no synthetic row");
  const edited = offlineFileHistory(page, saved, { path: "a.txt", size: 99, mtime: Date.UTC(2026, 8, 30, 11) });
  assert.equal(edited.versions[0].size, 99, "size comes from the file, like its date");
  assert.equal(edited.versions[0].created, "2026-09-30T11:00:00.000Z");
});

test("a deleted local row never leads and a missing file date stays unknown", () => {
  const page = { offline: true, versions: [row(4)], next: null };
  assert.deepEqual(offlineFileHistory(page, { rev: 6, deleted: 1 }, entry), { versions: page.versions, currentRev: 4 });
  const nodate = offlineFileHistory({ offline: true, versions: [], next: null }, saved, { path: "a.txt" });
  assert.equal(nodate.versions[0].created, null);
});

test("a quiet refresh only applies while the same file detail is still open", () => {
  const target = { volume: "v", path: "a.txt" };
  assert.equal(sameDetail({ kind: "history", volume: "v", path: "a.txt" }, target), true);
  for (const moved of [null, undefined, { kind: "conflict", volume: "v", path: "a.txt" }, { kind: "rename-file", volume: "v", path: "a.txt" }, { kind: "history", volume: "v", path: "b.txt" }, { kind: "history", volume: "w", path: "a.txt" }])
    assert.equal(sameDetail(moved, target), false, JSON.stringify(moved));
});
