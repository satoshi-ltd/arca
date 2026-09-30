import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const targets = (from, to) => {
  const quoted = (key) => [`"${key}": "${from}"`, `"${key}": "${to}"`];
  return [
    ["package.json", ...quoted("version"), 1],
    ["package-lock.json", ...quoted("version"), 2],
    ["apps/mobile/package.json", ...quoted("version"), 1],
    ["apps/mobile/package-lock.json", ...quoted("version"), 2],
    ["apps/mobile/app.json", ...quoted("version"), 1],
    ["apps/desktop/src-tauri/tauri.conf.json", ...quoted("version"), 1],
    ["apps/desktop/src-tauri/Cargo.toml", `\nversion = "${from}"`, `\nversion = "${to}"`, 1],
    [
      "apps/desktop/src-tauri/Cargo.lock",
      `name = "arca-desktop"\nversion = "${from}"`,
      `name = "arca-desktop"\nversion = "${to}"`,
      1,
    ],
    ["apps/mobile/modules/arca-network/ios/ArcaNetwork.podspec", `s.version = '${from}'`, `s.version = '${to}'`, 1],
    ["apps/mobile/modules/arca-network/android/build.gradle", `version = '${from}'`, `version = '${to}'`, 1],
    ["apps/mobile/modules/arca-network/android/build.gradle", `versionName '${from}'`, `versionName '${to}'`, 1],
    ["packages/daemon/network.js", `version: "${from}",`, `version: "${to}",`, 1],
    ["apps/desktop/src/app.js", `const APP_VERSION = "${from}";`, `const APP_VERSION = "${to}";`, 1],
    ["packages/cli/arca.js", `Arca ${from} — personal drive`, `Arca ${to} — personal drive`, 1],
    ["README.md", `**v${from} ·`, `**v${to} ·`, 1],
    ["SPEC.md", `**v${from} ·`, `**v${to} ·`, 1],
    ["design/index.html", `class="kit-version">v${from} ·`, `class="kit-version">v${to} ·`, 1],
    ["design/desktop.html", `class="kit-version">v${from} ·`, `class="kit-version">v${to} ·`, 1],
    ["design/mobile.html", `class="kit-version">v${from} ·`, `class="kit-version">v${to} ·`, 1],
  ];
};

export function bump(root, to) {
  const read = (file) =>
    fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
  const from = JSON.parse(read("package.json")).version;
  const [major, minor, patch] = from.split(".").map(Number);
  to ||= `${major}.${minor}.${patch + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(to)) throw new Error(`Invalid version ${to}`);
  const edits = new Map();
  for (const [file, before, after, expected] of targets(from, to)) {
    const text = edits.get(file) ?? read(file);
    const found = text.split(before).length - 1;
    if (found < expected)
      throw new Error(`${file}: expected ${expected} × ${JSON.stringify(before)}, found ${found}`);
    let left = expected;
    edits.set(
      file,
      text.replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), (match) =>
        left-- > 0 ? after : match,
      ),
    );
  }
  for (const [file, text] of edits) fs.writeFileSync(path.join(root, file), text);
  return { from, to };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const { from, to } = bump(repository, process.argv[2]);
  console.log(`${from} → ${to}. Add "## ${to} — ${new Date().toISOString().slice(0, 10)}" to CHANGELOG.md, then run node scripts/check-release.js.`);
}
