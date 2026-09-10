import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fail } from "./storage.js";
export function inspectSetupRoot(value, home) {
  if (typeof value !== "string" || !value.trim()) fail("Choose a folder root");
  if (value === "~" || value.startsWith("~/"))
    value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) fail("Choose an absolute folder path");
  const root = path.resolve(value);
  let existing = root;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const resolved = path.resolve(
    fs.realpathSync(existing),
    path.relative(existing, root),
  );
  const state = fs.existsSync(home)
    ? fs.realpathSync(home)
    : path.resolve(home);
  if (resolved === state || state.startsWith(resolved + path.sep))
    fail("Choose a folder outside Arca's state directory");
  if (
    fs.existsSync(root) &&
    (!fs.statSync(root).isDirectory() ||
      fs.readdirSync(root).some((name) => name !== ".DS_Store"))
  )
    fail("Choose an empty or new folder root");
  const disk = fs.statfsSync(existing);
  return { root: resolved, freeBytes: disk.bavail * disk.bsize };
}
