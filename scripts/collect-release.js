import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"}-${process.arch}`;
if (process.env.PLATFORM && process.env.PLATFORM !== platform)
  throw new Error(`Runner/runtime architecture mismatch: ${platform}`);
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json")),
).version;
const bundle = path.join(root, "apps/desktop/src-tauri/target/release/bundle");
const extensions =
  process.platform === "darwin"
    ? [".dmg"]
    : process.platform === "win32"
      ? [".exe"]
      : [".AppImage", ".deb"];
const destination = path.join(root, "release-assets");
fs.mkdirSync(destination, { recursive: true });
for (const extension of extensions) {
  const directory = path.join(
    bundle,
    { ".dmg": "dmg", ".exe": "nsis", ".AppImage": "appimage", ".deb": "deb" }[
      extension
    ],
  );
  const matches = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(extension));
  if (matches.length !== 1)
    throw new Error(
      `Expected one ${extension} installer, found ${matches.length}`,
    );
  fs.copyFileSync(
    path.join(directory, matches[0]),
    path.join(destination, `arca-${version}-${platform}${extension}`),
  );
}
console.log(`Collected ${extensions.length} installers for ${platform}`);
