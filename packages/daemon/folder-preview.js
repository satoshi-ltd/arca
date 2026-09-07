import fs from "node:fs/promises";
import path from "node:path";
import { compileIgnore, readIgnore } from "./exclusions.js";

// Metadata only: do not hash, read file contents or follow symbolic links.
export async function folderPreview(root) {
  try {
    await fs.lstat(root);
  } catch (error) {
    if (error.code === "ENOENT")
      return { files: 0, bytes: 0, skipped: 0, complete: true };
    throw error;
  }
  const excluded = compileIgnore(readIgnore(root));
  const result = { files: 0, bytes: 0, skipped: 0, complete: true };
  const pending = [""];
  const deadline = Date.now() + 5000;
  let visited = 0;
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (++visited > 100000 || Date.now() > deadline)
        return { ...result, complete: false };
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded(name, entry.isDirectory())) continue;
      const stat = await fs.lstat(path.join(root, name));
      if (stat.isDirectory()) pending.push(name);
      else if (stat.isFile()) {
        result.files++;
        result.bytes += stat.size;
      } else result.skipped++;
    }
  }
  return result;
}
