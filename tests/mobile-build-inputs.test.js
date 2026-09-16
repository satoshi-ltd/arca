import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("EAS archive includes every shared source imported by the mobile app", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "arca-eas-inputs-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", fixture]).status, 0);
  fs.copyFileSync(
    path.join(root, ".easignore"),
    path.join(fixture, ".gitignore"),
  );
  const shared = new Set();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:js|jsx)$/.test(file)) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(
          /(?:from\s*|import\s*)["'](\.[^"']+)["']/g,
        )) {
          const target = path.resolve(path.dirname(file), match[1]);
          const relative = path
            .relative(root, target)
            .split(path.sep)
            .join("/");
          if (!relative.startsWith("apps/mobile/")) shared.add(relative);
        }
      }
    }
  }
  walk(path.join(root, "apps/mobile/src"));
  assert.ok(shared.has("apps/desktop/src/file-icons.js"));
  for (const file of shared) {
    const result = spawnSync("git", ["check-ignore", "--no-index", file], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      1,
      `Shared mobile input excluded from EAS: ${file}\n${result.stderr}`,
    );
  }
});
