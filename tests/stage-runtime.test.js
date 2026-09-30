import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("staging the desktop runtime clears previously staged sources before copying", () => {
  const source = fs.readFileSync(new URL("../scripts/stage-runtime.js", import.meta.url), "utf8");
  const clear = source.indexOf('for (const staged of ["packages", "apps"])');
  assert.ok(clear > 0, "removed modules must not survive a restage");
  assert.match(source.slice(clear), /fs\.rmSync\(path\.join\(destination, staged\), \{ recursive: true, force: true \}\)/);
  assert.ok(clear < source.indexOf('fs.cpSync(path.join(root, "packages")'));
  assert.ok(clear < source.indexOf('path.join(root, "apps/desktop/src")'), "the whole renderer, notice contract included, is copied after clearing");
});
