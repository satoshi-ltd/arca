import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BUILD_INPUTS, IMAGE, OVERRIDE, overrideFile, remoteScript, sourceFiles } from "../scripts/build-local.js";

test("build:local sends only what the Docker image is built from, and skips deleted files", () => {
  const listed = ["package.json", "package-lock.json", "packages/daemon/server.js", "packages/core/x.js", "apps/desktop/src/app.js", "apps/desktop/src-tauri/src/main.rs", "apps/mobile/src/App.jsx", "deploy/Dockerfile", "deploy/compose.yaml", "tests/a.test.js", ".dockerignore", "packages/gone.js"];
  assert.deepEqual(sourceFiles(listed, (file) => file !== "packages/gone.js"), ["package.json", "package-lock.json", "packages/daemon/server.js", "packages/core/x.js", "apps/desktop/src/app.js", "deploy/Dockerfile", ".dockerignore"]);
  const dockerfile = fs.readFileSync(new URL("../deploy/Dockerfile", import.meta.url), "utf8");
  for (const copied of dockerfile.matchAll(/^COPY (.+) \S+$/gm))
    for (const source of copied[1].split(" "))
      assert.ok(BUILD_INPUTS.some((input) => source === input || source.startsWith(input + "/") || input.startsWith(source)), `${source} is sent`);
});

test("build:local swaps only the arca service image through an override, backs up the index first and falls back to the stock image when unhealthy", () => {
  assert.equal(overrideFile("0.8.0-abc"), `services:\n  arca:\n    image: ${IMAGE}:0.8.0-abc\n`);
  const script = remoteScript({ dir: "arca", tag: "0.8.0-abc" });
  const at = (part) => {
    const index = script.indexOf(part);
    assert.ok(index >= 0, part);
    return index;
  };
  assert.ok(at(`-t ${IMAGE}:0.8.0-abc`) < at("docker compose stop arca"), "the image builds before the running service stops");
  assert.ok(at("docker compose stop arca") < at("state/index.sqlite*") && at("state/index.sqlite*") < at(`-f ${OVERRIDE} up -d arca`), "the index is copied while the daemon is stopped");
  assert.match(script, /cat > docker-compose\.local\.yml <<'ARCA_LOCAL'\nservices:\n  arca:\n    image: arca-local:0\.8\.0-abc\nARCA_LOCAL/);
  assert.ok(at('if [ "$HEALTH" != healthy ]') < at("docker compose -f docker-compose.yml up -d arca"), "an unhealthy build goes back to the stock compose file");
  assert.doesNotMatch(script, /docker compose down|rm -rf state|docker volume/, "state and other services are never removed");
  assert.match(script, /--format '\{\{\.Tag\}\}'/);
  const rollback = remoteScript({ dir: "arca", rollback: true });
  assert.match(rollback, /rm -f docker-compose\.local\.yml\ndocker compose -f docker-compose\.yml up -d arca/);
});

test("build:local is a root npm script", () => {
  const scripts = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.equal(scripts["build:local"], "node scripts/build-local.js");
});
