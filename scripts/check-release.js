import fs from "node:fs";
import { found, manifests } from "./release-manifests.js";

const read = (file) =>
  fs
    .readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
const version = JSON.parse(read("package.json")).version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Expected an x.y.z release version");
const disagreeing = [
  ...new Set(
    manifests
      .filter(([file, template, expected]) => {
        const values = found(read(file), template).slice(0, expected);
        return (
          values.length < expected || values.some((value) => value !== version)
        );
      })
      .map(([file]) => file),
  ),
];
if (disagreeing.length)
  throw new Error(
    `Release versions disagree with package.json ${version}: ${disagreeing.join(", ")}`,
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
if (!read("CHANGELOG.md").includes(`## ${version} —`))
  throw new Error("Current version is missing from CHANGELOG.md");
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=v${version}\n`,
  );
console.log(`Release manifests agree: v${version}`);
