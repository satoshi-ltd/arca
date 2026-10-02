import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const REF = "LicenseRef-PolyForm-Strict-1.0.0";

test("every manifest names the PolyForm Strict License and none claims another", () => {
  for (const [file, pointer] of [
    ["package.json", "LICENSE"],
    ["apps/desktop/package.json", path.posix.join("../..", "LICENSE")],
    ["apps/mobile/package.json", path.posix.join("../..", "LICENSE")],
  ]) {
    const license = JSON.parse(read(file)).license;
    assert.equal(license, `SEE LICENSE IN ${pointer}`, file);
    assert.ok(
      fs.existsSync(path.join(root, path.dirname(file), pointer)),
      `${file} points at a file that exists`,
    );
  }
  assert.match(read("apps/desktop/src-tauri/Cargo.toml"), new RegExp(`^license = "${REF}"$`, "m"));
  assert.match(
    read("apps/mobile/modules/arca-network/ios/ArcaNetwork.podspec"),
    new RegExp(`s\\.license = '${REF}'`),
  );
  assert.match(read("LICENSE"), /# PolyForm Strict License 1\.0\.0/);
});

test("the Docker image carries the license label and copies only files the deploy scripts stage", () => {
  const dockerfile = read("deploy/Dockerfile");
  assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.licenses="${REF}"`));
  assert.doesNotMatch(dockerfile, /^COPY LICENSE/m);
});

test("the Umbrel listing names the license", () => {
  assert.match(
    read("deploy/umbrel/arca/umbrel-app.yml").replace(/\s+/g, " "),
    /PolyForm Strict License 1\.0\.0/,
  );
});
