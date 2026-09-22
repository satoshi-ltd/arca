import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
export function bundleConfig(platform, identity) {
  const bundle = {
    targets:
      platform === "darwin"
        ? ["app", "dmg"]
        : platform === "win32"
          ? ["nsis"]
          : ["appimage", "deb"],
  };
  if (platform === "darwin")
    bundle.macOS = { signingIdentity: identity, hardenedRuntime: true };
  return bundle;
}
export function withRetry(work, attempts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return work(attempt);
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.error(`${error.message}; retrying (${attempt}/${attempts - 1})`);
    }
  }
}
export function buildInstallers(platform, identity, execute = run) {
  const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
  const options = [
    "--verbose",
    "--config",
    JSON.stringify({ bundle: bundleConfig(platform, identity) }),
  ];
  if (platform !== "darwin") {
    execute(process.execPath, [cli, "build", ...options], desktop);
    return;
  }
  execute(process.execPath, [cli, "build", "--no-bundle", ...options], desktop);
  withRetry(
    () => execute(process.execPath, [cli, "bundle", ...options], desktop),
    2,
  );
}
function main() {
  const signed = process.env.ARCA_SIGN_MACOS === "true";
  const mac = process.platform === "darwin";
  if (mac && signed && !process.env.APPLE_SIGNING_IDENTITY)
    throw new Error("Signed release requires APPLE_SIGNING_IDENTITY");
  const identity = signed ? process.env.APPLE_SIGNING_IDENTITY : "-";
  run(process.execPath, ["scripts/check-release.js"]);
  run(process.execPath, ["scripts/stage-runtime.js"]);
  if (mac)
    run("codesign", [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--entitlements",
      path.join(desktop, "src-tauri/Entitlements.plist"),
      ...(signed ? ["--timestamp"] : []),
      path.join(desktop, "src-tauri/runtime/node"),
    ]);
  buildInstallers(process.platform, identity);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
