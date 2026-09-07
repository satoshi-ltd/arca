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
  JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version,
  /^version = "([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1],
  /name = "arca-desktop"\r?\nversion = "([^"]+)"/.exec(
    read("apps/desktop/src-tauri/Cargo.lock"),
  )?.[1],
];
if (versions.some((value) => value !== version))
  throw new Error(
    "Release versions disagree across package, lockfiles and Tauri",
  );
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=v${version}\n`,
  );
console.log(`Release manifests agree: v${version}`);
