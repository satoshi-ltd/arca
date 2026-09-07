import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
if (process.platform === "darwin") {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const app = path.join(
    root,
    "apps/desktop/src-tauri/target/release/bundle/macos/Arca.app",
  );
  const result = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", app],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Local ad-hoc signing failed");
  const verification = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", app],
    { stdio: "inherit" },
  );
  if (verification.status !== 0)
    throw new Error("Local signature verification failed");
  console.log(
    "Local ad-hoc signature verified (not notarized for distribution)",
  );
}
