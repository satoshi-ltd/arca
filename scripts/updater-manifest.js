import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATER_TARGETS = {
  "darwin-aarch64": (version) => `arca-${version}-macos-arm64.app.tar.gz`,
  "windows-x86_64": (version) => `arca-${version}-windows-x64.exe`,
  // The plugin reads {os}-{arch}-{installer} before {os}-{arch}: a Debian install must not receive an AppImage.
  "linux-x86_64-deb": (version) => `arca-${version}-linux-x64.deb`,
  "linux-x86_64": (version) => `arca-${version}-linux-x64.AppImage`,
};
export function updaterManifest({
  version,
  repository,
  tag,
  notes,
  date,
  read,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || ""))
    throw new Error("Expected an x.y.z release version");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || ""))
    throw new Error("Repository is required");
  const platforms = {};
  for (const [target, asset] of Object.entries(UPDATER_TARGETS)) {
    const name = asset(version);
    const signature = (read(`${name}.sig`) || "").trim();
    if (!signature) throw new Error(`Missing updater signature: ${name}.sig`);
    platforms[target] = {
      signature,
      url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    };
  }
  return {
    version,
    notes: notes || `Arca ${version}`,
    pub_date: date,
    platforms,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = process.argv[2] || "release-assets";
  const version = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const manifest = updaterManifest({
    version,
    repository: process.env.GITHUB_REPOSITORY || "satoshi-ltd/arca",
    tag: `v${version}`,
    notes: process.env.UPDATE_NOTES,
    date: new Date().toISOString(),
    read: (name) => {
      const file = path.join(directory, name);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
  });
  fs.writeFileSync(
    path.join(directory, "latest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    `Updater manifest for v${version}: ${Object.keys(manifest.platforms).join(", ")}`,
  );
}
