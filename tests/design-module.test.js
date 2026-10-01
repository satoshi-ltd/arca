import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("design/ owns its contract and generator, and scripts/ holds no design file", () => {
  const contract = path.join(root, "design", "AGENTS.md");
  assert.ok(fs.existsSync(contract), "design/AGENTS.md is missing");
  const claude = path.join(root, "design", "CLAUDE.md");
  if (fs.existsSync(claude)) assert.equal(fs.readFileSync(claude, "utf8").trim(), "@AGENTS.md");
  assert.ok(fs.existsSync(path.join(root, "design", "build.js")));
  assert.deepEqual(
    fs.readdirSync(path.join(root, "scripts")).filter((name) => /design/i.test(name)),
    [],
  );
});
