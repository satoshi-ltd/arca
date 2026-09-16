import fs from "node:fs";
const read = (file) =>
  fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const version = JSON.parse(read("package.json")).version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Expected an x.y.z release version");
const lock = JSON.parse(read("package-lock.json"));
const versions = [
  lock.version,
  lock.packages[""].version,
  JSON.parse(read("apps/mobile/package.json")).version,
  JSON.parse(read("apps/mobile/package-lock.json")).version,
  JSON.parse(read("apps/mobile/package-lock.json")).packages[""].version,
  JSON.parse(read("apps/mobile/app.json")).expo.version,
  JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version,
  /^version = "([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1],
  /name = "arca-desktop"\r?\nversion = "([^"]+)"/.exec(
    read("apps/desktop/src-tauri/Cargo.lock"),
  )?.[1],
  /s\.version\s*=\s*'([^']+)'/.exec(
    read("apps/mobile/modules/arca-network/ios/ArcaNetwork.podspec"),
  )?.[1],
  /^version\s*=\s*'([^']+)'/m.exec(
    read("apps/mobile/modules/arca-network/android/build.gradle"),
  )?.[1],
  /versionName\s+'([^']+)'/.exec(
    read("apps/mobile/modules/arca-network/android/build.gradle"),
  )?.[1],
  /version:\s*"([^"]+)"/.exec(read("packages/daemon/network.js"))?.[1],
  /Arca v([\d.]+)/.exec(read("apps/desktop/src/app.js"))?.[1],
  /version:\s*"([^"]+)"/.exec(read("apps/desktop/src/app.js"))?.[1],
  /Arca ([\d.]+) — personal drive/.exec(read("packages/cli/arca.js"))?.[1],
];
if (versions.some((value) => value !== version))
  throw new Error(
    "Release versions disagree across desktop/mobile packages, lockfiles and Tauri",
  );
const mobile = JSON.parse(read("apps/mobile/app.json")).expo;
const nativeCode = /versionCode\s+(\d+)/.exec(
  read("apps/mobile/modules/arca-network/android/build.gradle"),
)?.[1];
if (
  String(mobile.android.versionCode) !== mobile.ios.buildNumber ||
  String(mobile.android.versionCode) !== nativeCode
)
  throw new Error("Mobile native build numbers disagree");
if (!read("changelog.md").includes(`## ${version} —`))
  throw new Error("Current version is missing from changelog.md");
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=v${version}\n`,
  );
console.log(`Release manifests agree: v${version}`);
