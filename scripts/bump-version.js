import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifests } from "./release-manifests.js";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const targets = (from, to) =>
  manifests.map(([file, template, expected]) => [
    file,
    template.split("{version}").join(from),
    template.split("{version}").join(to),
    expected,
  ]);

export function bump(root, to) {
  const read = (file) =>
    fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
  const from = JSON.parse(read("package.json")).version;
  const [major, minor, patch] = from.split(".").map(Number);
  to ||= `${major}.${minor}.${patch + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(to)) throw new Error(`Invalid version ${to}`);
  const edits = new Map();
  for (const [file, before, after, expected] of targets(from, to)) {
    const text = edits.get(file) ?? read(file);
    const found = text.split(before).length - 1;
    if (found < expected)
      throw new Error(`${file}: expected ${expected} × ${JSON.stringify(before)}, found ${found}`);
    let left = expected;
    edits.set(
      file,
      text.replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), (match) =>
        left-- > 0 ? after : match,
      ),
    );
  }
  for (const [file, text] of edits) fs.writeFileSync(path.join(root, file), text);
  return { from, to };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const { from, to } = bump(repository, process.argv[2]);
  console.log(`${from} → ${to}. Add "## ${to} — ${new Date().toISOString().slice(0, 10)}" to CHANGELOG.md, then run node scripts/check-release.js.`);
}
