import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { folderPreview } from "../packages/daemon/folder-preview.js";
test("preview counts metadata using ignore rules without creating files or following symlinks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arca-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await folderPreview(path.join(root, "missing")), {
    files: 0,
    bytes: 0,
    skipped: 0,
    complete: true,
  });
  await fs.writeFile(path.join(root, "keep"), "abc");
  assert.equal((await folderPreview(root)).bytes, 3);
  assert.deepEqual(await fs.readdir(root), ["keep"]);
  const rules = "cache/\n.env\n";
  await fs.writeFile(path.join(root, ".arcaignore"), rules);
  await fs.mkdir(path.join(root, "cache"));
  await fs.writeFile(path.join(root, "cache", "data"), "excluded");
  await fs.writeFile(path.join(root, ".env"), "excluded");
  await fs.symlink("/missing", path.join(root, "link"));
  await fs.writeFile(path.join(root, ".arca-volume"), "internal");
  assert.deepEqual(await folderPreview(root), {
    files: 2,
    bytes: 3 + Buffer.byteLength(rules),
    skipped: 1,
    complete: true,
  });
});
