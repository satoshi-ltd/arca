import test from "node:test";
import assert from "node:assert/strict";
import { fileIcon, fileIconTypes } from "../apps/desktop/src/file-icons.js";
import { icons } from "../apps/mobile/src/icons.js";

test("file types share available mobile icons with a safe fallback", () => {
  const extensions = new Set();
  for (const type of fileIconTypes) {
    assert.ok(icons[type.icon], type.icon);
    for (const extension of type.extensions) {
      assert.equal(extensions.has(extension), false, extension);
      extensions.add(extension);
      assert.equal(
        fileIcon(`folder/name.${extension.toUpperCase()}`),
        type.icon,
      );
    }
  }
  assert.equal(fileIcon("folder.pdf", true), "folder");
  assert.equal(fileIcon("folder.pdf/no-extension"), "file");
  assert.equal(fileIcon(".apk"), "file");
  assert.equal(fileIcon("C:\\docs\\café.PDF"), "file-type");
  assert.equal(fileIcon("notes.md.exe"), "package");
  assert.equal(fileIcon("unknown.xyz"), "file");
  assert.equal(fileIcon(null), "file");
});
