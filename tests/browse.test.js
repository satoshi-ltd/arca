import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { browsePage } from "../packages/daemon/pages.js";
test("browse groups directories, scopes search and paginates without including deleted files", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE files(volume TEXT, path TEXT, size INTEGER, rev INTEGER, deleted INTEGER, directory INTEGER DEFAULT 0, hash TEXT)",
    );
    const put = db.prepare(
      "INSERT INTO files(volume,path,size,rev,deleted) VALUES(?,?,?,?,?)",
    );
    for (const [path, size, deleted] of [
      ["notes/a.md", 10, 0],
      ["notes/deep/b.md", 20, 0],
      ["notes/removed.md", 30, 1],
      ["notes.md", 1, 0],
      ["notes b/y.md", 1, 0],
      ["notes0/x.md", 1, 0],
      ["notesZ/z.md", 1, 0],
      ["root.txt", 5, 0],
      ["📁/hello.txt", 4, 0],
    ])
      put.run("v", path, size, 1, deleted);
    put.run("other", "leak.txt", 100, 1, 0);
    db.exec("UPDATE files SET hash='content-hash' WHERE path='root.txt'");
    const browse = (values = {}) =>
      browsePage({ db, fileSource: () => "files" }, "v", new URLSearchParams(values));
    const first = browse({ limit: "1" });
    assert.equal(first.entries[0].name, "notes");
    assert.equal(first.entries[0].files, 2);
    assert.equal(first.entries[0].size, 30);
    assert.ok(first.next);
    assert.equal(first.entries[0].hash, undefined);
    assert.equal(browse({ search: "root.txt" }).entries[0].hash, "content-hash");
    assert.equal(
      browse({ limit: "1", after: first.next }).entries[0].name,
      "notes b",
    );
    assert.deepEqual(
      browse({ prefix: "notes" }).entries.map((r) => r.name),
      ["deep", "a.md"],
    );
    assert.equal(browse({ prefix: "📁" }).entries[0].name, "hello.txt");
    assert.equal(
      browse({ prefix: "notes", search: "B.MD" }).entries[0].path,
      "notes/deep/b.md",
    );
    assert.deepEqual(browse({ prefix: "../" }).entries, []);
    assert.equal(browse({ search: "removed" }).entries.length, 0);
    assert.throws(() => browse({ limit: "100000" }));
  } finally {
    db.close();
  }
});
