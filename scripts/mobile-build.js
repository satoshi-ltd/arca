import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mobile = path.join(root, "apps/mobile");
const mode = process.argv[2];
if (process.argv.includes("--install-only") && mode !== "dev")
  throw new Error("--install-only is for dev builds");
if (!["dev", "prod"].includes(mode))
  throw new Error("Use mobile-build.js dev|prod");
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Android/sdk")
    : path.join(os.homedir(), "Android/Sdk"));
const java =
  process.env.JAVA_HOME ||
  (process.platform === "darwin"
    ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    : undefined);
const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ...(java ? { JAVA_HOME: java } : {}),
};
function run(command, args, cwd = mobile) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync(path.join(mobile, "node_modules/expo")))
  throw new Error("Run npm ci --prefix apps/mobile first");
run(process.execPath, ["scripts/check-release.js"], root);
const version = JSON.parse(fs.readFileSync(path.join(mobile, "app.json"))).expo
  .version;
const output = path.join(
  root,
  "release-assets",
  `arca-${version}-android${mode === "dev" ? "-dev" : ""}.apk`,
);
fs.mkdirSync(path.dirname(output), { recursive: true });
// --local is mandatory: credentials come from EAS, compilation never uses a cloud worker.
if (!process.argv.includes("--install-only"))
  run("npx", [
    "--yes",
    "eas-cli",
    "build",
    "--local",
    "--platform",
    "android",
    "--profile",
    mode === "dev" ? "development" : "production",
    "--output",
    output,
  ]);
if (!fs.existsSync(output)) throw new Error("EAS did not produce the APK");
console.log(`APK: ${output}`);
if (mode === "dev") {
  const adb = path.join(sdk, "platform-tools/adb");
  const emulator = path.join(sdk, "emulator/emulator");
  const avd = process.env.ARCA_ANDROID_AVD || "Pixel_9_Pro_Fold";
  function read(args) {
    const r = spawnSync(adb, args, { env, encoding: "utf8" });
    if (r.error) throw r.error;
    return r.status === 0 ? r.stdout.trim() : "";
  }
  function device() {
    return read(["devices"])
      .split("\n")
      .map((line) => line.split(/\s+/)[0])
      .find(
        (id) =>
          id.startsWith("emulator-") &&
          read(["-s", id, "emu", "avd", "name"]).split(/\r?\n/)[0] === avd,
      );
  }
  let serial = device();
  if (!serial) {
    const available = spawnSync(emulator, ["-list-avds"], {
      env,
      encoding: "utf8",
    });
    if (!available.stdout?.split(/\r?\n/).includes(avd))
      throw new Error(`Emulator not found: ${avd}`);
    const child = spawn(emulator, ["-avd", avd], {
      env,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.unref();
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    serial = device();
    if (
      serial &&
      read(["-s", serial, "shell", "getprop", "sys.boot_completed"]) === "1"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (
    !serial ||
    read(["-s", serial, "shell", "getprop", "sys.boot_completed"]) !== "1"
  )
    throw new Error("Emulator did not boot within 3 minutes");
  // Never uninstall or clear user data to work around a signing/version mismatch.
  run(adb, ["-s", serial, "install", "-r", output]);
  run(adb, ["-s", serial, "reverse", "tcp:8081", "tcp:8081"]);
  run(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-n",
    "com.satoshilimited.arca/.MainActivity",
  ]);
  console.log(
    "Installed on " + avd + ". Metro remains user-managed: npm run mobile",
  );
}
