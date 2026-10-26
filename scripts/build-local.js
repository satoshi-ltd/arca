#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_INPUTS = ["package.json", "package-lock.json", "packages", "apps/desktop/src", "deploy/Dockerfile", ".dockerignore"];
export const IMAGE = "arca-local";
export const OVERRIDE = "docker-compose.local.yml";

export function overrideFile(tag) {
  return `services:\n  arca:\n    image: ${IMAGE}:${tag}\n`;
}

export function sourceFiles(listed, exists) {
  return listed.filter(
    (file) => BUILD_INPUTS.some((input) => file === input || file.startsWith(input + "/")) && exists(file),
  );
}

export function remoteScript({ dir, tag, rollback }) {
  const base = `cd "$HOME/${dir}"`;
  if (rollback)
    return [
      "set -eu",
      base,
      `rm -f ${OVERRIDE}`,
      "docker compose -f docker-compose.yml up -d arca",
      "docker compose -f docker-compose.yml ps arca",
    ].join("\n");
  return [
    "set -eu",
    `BUILD="$HOME/${dir}-local"`,
    `docker build -q -f "$BUILD/src/deploy/Dockerfile" -t ${IMAGE}:${tag} -t ${IMAGE}:latest "$BUILD/src"`,
    base,
    "STAMP=$(date +%Y%m%d-%H%M%S)",
    'mkdir -p "$BUILD/state-backups/$STAMP"',
    "docker compose stop arca",
    'cp -a state/config.json state/index.sqlite* "$BUILD/state-backups/$STAMP/" 2>/dev/null || true',
    'ls -1dt "$BUILD"/state-backups/* | tail -n +4 | xargs -r rm -rf',
    `cat > ${OVERRIDE} <<'ARCA_LOCAL'`,
    overrideFile(tag).trimEnd(),
    "ARCA_LOCAL",
    `docker compose -f docker-compose.yml -f ${OVERRIDE} up -d arca`,
    "for i in $(seq 1 45); do",
    '  HEALTH=$(docker inspect arca --format "{{.State.Health.Status}}" 2>/dev/null || echo missing)',
    '  [ "$HEALTH" = healthy ] && break',
    "  sleep 2",
    "done",
    'if [ "$HEALTH" != healthy ]; then',
    '  echo "arca did not become healthy ($HEALTH); going back to the stock image"',
    "  docker logs --tail 40 arca || true",
    `  rm -f ${OVERRIDE}`,
    "  docker compose -f docker-compose.yml up -d arca",
    "  exit 1",
    "fi",
    "docker logs --tail 10 arca",
    `docker image ls ${IMAGE} --format '{{.Tag}}' | grep -v -e latest -e '^${tag}$' | tail -n +4 | xargs -r -I{} docker image rm ${IMAGE}:{} >/dev/null 2>&1 || true`,
    `echo "arca is running ${IMAGE}:${tag}"`,
  ].join("\n");
}

function ssh(host, script, input) {
  const run = spawnSync("ssh", [host, "sh -s"], { input: input ?? script, stdio: ["pipe", "inherit", "inherit"] });
  if (run.status !== 0) process.exit(run.status || 1);
}

function main() {
  const host = process.env.ARCA_LOCAL_HOST || "atlas";
  const dir = process.env.ARCA_LOCAL_DIR || "arca";
  const rollback = process.argv.includes("--rollback");
  if (rollback) return ssh(host, remoteScript({ dir, rollback }));
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim() ? `-dirty-${Date.now().toString(36)}` : "";
  const tag = `${version}-${sha}${dirty}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
  const files = sourceFiles(listed, (file) => fs.existsSync(path.join(root, file)));
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arca-local-")), "files");
  fs.writeFileSync(list, files.join("\0"));
  const archive = execFileSync("tar", ["--no-xattrs", "--null", "-T", list, "-czf", "-"], { cwd: root, maxBuffer: 1024 ** 3 });
  console.log(`Sending ${files.length} files to ${host} for ${IMAGE}:${tag}`);
  const upload = spawnSync(
    "ssh",
    [host, `set -eu; BUILD="$HOME/${dir}-local"; rm -rf "$BUILD/src"; mkdir -p "$BUILD/src"; tar -xzf - -C "$BUILD/src"`],
    { input: archive, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (upload.status !== 0) process.exit(upload.status || 1);
  ssh(host, remoteScript({ dir, tag }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
