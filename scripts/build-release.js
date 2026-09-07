import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const signed = process.env.ARCA_SIGN_MACOS === "true";
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
run(process.execPath, ["scripts/check-release.js"]);
run(process.execPath, ["scripts/stage-runtime.js"]);
const bundle = {
  targets:
    process.platform === "darwin"
      ? ["app", "dmg"]
      : process.platform === "win32"
        ? ["nsis"]
        : ["appimage", "deb"],
};
if (process.platform === "darwin") {
  if (signed && !process.env.APPLE_SIGNING_IDENTITY)
    throw new Error("Signed release requires APPLE_SIGNING_IDENTITY");
  run("codesign", [
    "--force",
    "--sign",
    signed ? process.env.APPLE_SIGNING_IDENTITY : "-",
    "--options",
    "runtime",
    "--entitlements",
    path.join(desktop, "src-tauri/Entitlements.plist"),
    ...(signed ? ["--timestamp"] : []),
    path.join(desktop, "src-tauri/runtime/node"),
  ]);
  bundle.macOS = {
    signingIdentity: signed ? process.env.APPLE_SIGNING_IDENTITY : "-",
    hardenedRuntime: true,
  };
}
run(
  process.execPath,
  [
    path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "build",
    "--config",
    JSON.stringify({ bundle }),
  ],
  desktop,
);
