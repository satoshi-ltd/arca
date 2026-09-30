import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { budgetFromEnvironment, pruneCargo } from "../scripts/prune-cargo.js";

test("desktop builds drop incremental caches first and remove the measured target only if still over budget", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-cargo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const file = (relative, size) => {
    fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
    fs.writeFileSync(path.join(target, relative), crypto.randomBytes(size));
  };
  file("debug/deps/app.rlib", 64 * 1024);
  file("debug/incremental/app/cache.bin", 256 * 1024);
  assert.equal(pruneCargo({ target, budget: 1024 ** 3 }), "kept");
  assert.ok(fs.existsSync(path.join(target, "debug/incremental")));
  assert.equal(pruneCargo({ target, budget: 160 * 1024 }), "incremental");
  assert.equal(fs.existsSync(path.join(target, "debug/incremental")), false);
  assert.ok(fs.existsSync(path.join(target, "debug/deps/app.rlib")), "compiled dependencies survive");
  assert.equal(pruneCargo({ target, budget: 16 * 1024 }), "cleaned");
  assert.equal(fs.existsSync(target), false, "the directory that was measured is the one removed");
  assert.equal(pruneCargo({ target: path.join(root, "missing"), budget: 0 }), "kept");
  const staging = fs.readFileSync(new URL("../scripts/stage-runtime.js", import.meta.url), "utf8");
  assert.match(staging, /\npruneCargo\(\);\n/, "every desktop start, build and release stages the runtime first");
});

test("the Cargo budget accepts only a positive number of gigabytes", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(budgetFromEnvironment(undefined), 10 * 1024 ** 3);
    assert.equal(budgetFromEnvironment("3"), 3 * 1024 ** 3);
    assert.equal(budgetFromEnvironment("0.5"), 0.5 * 1024 ** 3);
    for (const invalid of ["15GB", " ", "0", "-2"]) assert.equal(budgetFromEnvironment(invalid), 10 * 1024 ** 3, invalid);
  } finally {
    console.warn = warn;
  }
});
