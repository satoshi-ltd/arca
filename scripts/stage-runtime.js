import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "apps/desktop/src-tauri/runtime");
const version = "24.14.0";
const platform = process.platform;
if (!["darwin", "linux", "win32"].includes(platform))
  throw new Error("Unsupported runtime platform");
const name =
  platform === "win32"
    ? `win-${process.arch}/node.exe`
    : `node-v${version}-${platform}-${process.arch}.tar.gz`;
const cache = path.join(root, ".cache", "runtime");
fs.mkdirSync(cache, { recursive: true });
const binary = path.join(
  cache,
  `node-${version}-${platform}-${process.arch}${platform === "win32" ? ".exe" : ""}`,
);
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
if (!fs.existsSync(binary)) {
  const base = `https://nodejs.org/dist/v${version}/`;
  const sums = (await download(base + "SHASUMS256.txt")).toString();
  const expected = sums
    .split("\n")
    .find((line) => line.trim().endsWith("  " + name))
    ?.split(" ")[0];
  if (!expected) throw new Error("Official Node checksum not found");
  const data = await download(base + name);
  if (crypto.createHash("sha256").update(data).digest("hex") !== expected)
    throw new Error("Node checksum mismatch");
  if (platform === "win32") fs.writeFileSync(binary, data);
  else {
    const archive = path.join(cache, path.basename(name));
    fs.writeFileSync(archive, data);
    const result = spawnSync("tar", ["-xzf", archive, "-C", cache], {
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error("Runtime extraction failed");
    fs.copyFileSync(
      path.join(cache, `node-v${version}-${platform}-${process.arch}/bin/node`),
      binary,
    );
    fs.chmodSync(binary, 0o755);
  }
}
fs.mkdirSync(destination, { recursive: true });
const target = path.join(
  destination,
  platform === "win32" ? "node.exe" : "node",
);
// Replace the executable inode: overwriting a running signed binary can
// leave macOS with a stale code-signature cache on the next launch.
const stagedBinary = `${target}.next`;
fs.copyFileSync(binary, stagedBinary);
fs.chmodSync(stagedBinary, 0o755);
fs.renameSync(stagedBinary, target);
fs.cpSync(path.join(root, "packages"), path.join(destination, "packages"), {
  recursive: true,
});
// The daemon and both app renderers consume one platform-neutral notice contract.
const sharedNotice = path.join(
  destination,
  "apps/desktop/src/notice-contract.js",
);
fs.mkdirSync(path.dirname(sharedNotice), { recursive: true });
fs.copyFileSync(
  path.join(root, "apps/desktop/src/notice-contract.js"),
  sharedNotice,
);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
fs.writeFileSync(
  path.join(destination, "package.json"),
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    type: "module",
    private: true,
    arcaInstallation: "desktop",
    dependencies: manifest.dependencies,
  }),
);
// Install only production packages for the target host (including sharp's native runtime).
fs.copyFileSync(
  path.join(root, "package-lock.json"),
  path.join(destination, "package-lock.json"),
);
const dependencies = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--omit=dev", "--ignore-scripts"],
  { cwd: destination, stdio: "inherit", shell: process.platform === "win32" },
);
if (dependencies.status !== 0)
  throw new Error("Could not stage runtime dependencies");
console.log(
  `Arca runtime staged: official Node ${version} (${platform}/${process.arch})`,
);

const nodeLicense = path.join(
  cache,
  `node-v${version}-${platform}-${process.arch}`,
  "LICENSE",
);
if (fs.existsSync(nodeLicense))
  fs.copyFileSync(nodeLicense, path.join(destination, "LICENSE.node"));
else
  fs.writeFileSync(
    path.join(destination, "LICENSE.node"),
    await download(
      `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`,
    ),
  );

fs.cpSync(
  path.join(root, "apps/desktop/src"),
  path.join(destination, "apps/desktop/src"),
  { recursive: true },
);
