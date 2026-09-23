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
const updaters =
  process.platform === "darwin"
    ? [{ directory: "macos", suffix: ".app.tar.gz", payload: true }]
    : process.platform === "win32"
      ? [{ directory: "nsis", suffix: ".exe" }]
      : [
          { directory: "appimage", suffix: ".AppImage" },
          { directory: "deb", suffix: ".deb" },
        ];
for (const updater of updaters) {
  const source = path.join(bundle, updater.directory);
  const signature = fs
    .readdirSync(source)
    .find((file) => file.endsWith(`${updater.suffix}.sig`));
  if (!signature)
    throw new Error(`Missing updater signature in ${updater.directory}`);
  const target = `arca-${version}-${platform}${updater.suffix}`;
  fs.copyFileSync(
    path.join(source, signature),
    path.join(destination, `${target}.sig`),
  );
  if (updater.payload)
    fs.copyFileSync(
      path.join(source, signature.replace(/\.sig$/, "")),
      path.join(destination, target),
    );
}
console.log(
  `Collected ${extensions.length} installers and ${updaters.length} updater signatures for ${platform}`,
);
