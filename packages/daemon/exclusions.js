import fs from "node:fs";
import path from "node:path";
import ignore from "../vendor/ignore/index.cjs";

import { builtinExcluded } from "../core/builtin-exclusions.js";

export const IGNORE_FILE = ".arcaignore";
export const MAX_IGNORE_BYTES = 64 * 1024;
export const DEFAULT_IGNORE = fs.readFileSync(
  new URL("./default.arcaignore", import.meta.url),
  "utf8",
);

// Seed once; never replace user rules. An empty file disables user exclusions, not built-in metadata exclusions.
export function ensureIgnore(root, includes = []) {
  let text = DEFAULT_IGNORE;
  if (Array.isArray(includes) && includes.length) {
    // Preserve the old exact-component exceptions when migrating an existing share.
    const names = new Set(includes.map((n) => String(n).toLowerCase()));
    text = text
      .split(/\r?\n/)
      .filter((line) => !names.has(line.replace(/\/$/, "").toLowerCase()))
      .join("\n");
  }
  try {
    fs.writeFileSync(path.join(root, IGNORE_FILE), text, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}

export function readIgnore(root) {
  if (!fs.lstatSync(path.join(root, IGNORE_FILE), { throwIfNoEntry: false }))
    return "";
  const fd = fs.openSync(
    path.join(root, IGNORE_FILE),
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IGNORE_BYTES)
      throw new Error(".arcaignore must be a regular file of at most 64 KiB");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function compileIgnore(text) {
  if (Buffer.byteLength(text) > MAX_IGNORE_BYTES)
    throw new Error(".arcaignore exceeds 64 KiB");
  const rules = ignore({ ignorecase: true }).add(text);
  return (name, directory = false) => {
    if (builtinExcluded(name)) return true;
    // Internal bookkeeping and unsupported file types remain safety invariants.
    if (name.split("/").some((part) => part.startsWith(".arca-"))) return true;
    if (name === IGNORE_FILE) return false;
    return rules.ignores(name + (directory && !name.endsWith("/") ? "/" : ""));
  };
}
