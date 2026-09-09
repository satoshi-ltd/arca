import { readFile, mkdir, writeFile } from "node:fs/promises";
const version = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const builds = JSON.parse(await readFile(process.argv[2], "utf8"));
const build = Array.isArray(builds) && builds.length === 1 ? builds[0] : null;
if (
  !build ||
  build.status !== "FINISHED" ||
  build.platform !== "ANDROID" ||
  build.appVersion !== version
)
  throw new Error("EAS did not finish the expected Android version");
const url = new URL(build.artifacts.applicationArchiveUrl);
if (url.protocol !== "https:") throw new Error("Expected HTTPS EAS artifact");
const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
if (!response.ok)
  throw new Error(`EAS artifact download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 1000 || bytes.readUInt32LE(0) !== 0x04034b50)
  throw new Error("EAS artifact is not an APK archive");
await mkdir("release-assets", { recursive: true });
await writeFile(`release-assets/arca-${version}-android.apk`, bytes);
