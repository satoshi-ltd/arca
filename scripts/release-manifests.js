export const manifests = [
  ["package.json", '"version": "{version}"', 1],
  ["package-lock.json", '"version": "{version}"', 2],
  ["apps/mobile/package.json", '"version": "{version}"', 1],
  ["apps/mobile/package-lock.json", '"version": "{version}"', 2],
  ["apps/mobile/app.json", '"version": "{version}"', 1],
  ["apps/desktop/src-tauri/tauri.conf.json", '"version": "{version}"', 1],
  ["apps/desktop/src-tauri/Cargo.toml", '\nversion = "{version}"', 1],
  ["apps/desktop/src-tauri/Cargo.lock", 'name = "arca-desktop"\nversion = "{version}"', 1],
  ["apps/mobile/modules/arca-network/ios/ArcaNetwork.podspec", "s.version = '{version}'", 1],
  ["apps/mobile/modules/arca-network/android/build.gradle", "\nversion = '{version}'", 1],
  ["apps/mobile/modules/arca-network/android/build.gradle", "versionName '{version}'", 1],
  ["packages/daemon/network.js", 'version: "{version}",', 1],
  ["apps/desktop/src/app.js", 'const APP_VERSION = "{version}";', 1],
  ["packages/cli/arca.js", "Arca {version} — personal drive", 1],
  ["README.md", "**v{version} ·", 1],
  ["SPEC.md", "**v{version} ·", 1],
  ["design/index.html", 'class="kit-version">v{version} ·', 1],
  ["design/desktop.html", 'class="kit-version">v{version} ·', 1],
  ["design/mobile.html", 'class="kit-version">v{version} ·', 1],
  ["design/auto.html", 'class="kit-version">v{version} ·', 1],
  ["design/proposals.html", 'class="kit-version">v{version} ·', 1],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pattern = (template) =>
  new RegExp(
    template.split("{version}").map(escape).join("(\\S*?)"),
    "g",
  );

export const found = (text, template) =>
  [...text.matchAll(pattern(template))].map((match) => match[1]);
