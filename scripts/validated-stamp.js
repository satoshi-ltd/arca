import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function hashFile(hash, file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (let count = fs.readSync(descriptor, buffer, 0, buffer.length, null); count > 0; count = fs.readSync(descriptor, buffer, 0, buffer.length, null))
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
}

export function fingerprint(source) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: source,
    maxBuffer: 1 << 30,
  });
  const hash = crypto.createHash("sha256");
  for (const file of [...new Set(listed.toString().split("\0").filter(Boolean))].sort()) {
    const full = path.join(source, file);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    hash.update(`${file}\0`);
    if (stat.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(full)}`);
    else if (stat.isFile()) hashFile(hash, full);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const stampPath = (source) =>
  path.resolve(source, execFileSync("git", ["rev-parse", "--git-path", "arca-validated"], { cwd: source, encoding: "utf8" }).trim());

export function writeStamp(source, value) {
  fs.writeFileSync(stampPath(source), JSON.stringify({ fingerprint: value }));
}

export function stampMatches(source) {
  try {
    return JSON.parse(fs.readFileSync(stampPath(source), "utf8")).fingerprint === fingerprint(source);
  } catch {
    return false;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) && process.argv[2] === "check") {
  const matches = stampMatches(process.argv[3] ? path.resolve(process.argv[3]) : repository);
  console.log(matches ? "validate-local already passed on these exact files; skipping the suite" : "no matching validation stamp; running the suite");
  process.exit(matches ? 0 : 1);
}
