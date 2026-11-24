import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const REF = "AGPL-3.0-only";

test("every manifest names the GNU AGPL-3.0 and none claims another", () => {
  for (const file of ["package.json", "apps/desktop/package.json", "apps/mobile/package.json"])
    assert.equal(JSON.parse(read(file)).license, REF, file);
  assert.match(read("apps/desktop/src-tauri/Cargo.toml"), new RegExp(`^license = "${REF}"$`, "m"));
  assert.match(
    read("apps/mobile/modules/arca-network/ios/ArcaNetwork.podspec"),
    new RegExp(`s\\.license = '${REF}'`),
  );
  const license = read("LICENSE");
  assert.match(license, /^ {20}GNU AFFERO GENERAL PUBLIC LICENSE\n {23}Version 3, 19 November 2007\n/);
  assert.equal(
    crypto.createHash("sha256").update(license).digest("hex"),
    "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0",
    "LICENSE is the unmodified text from gnu.org",
  );
  const readme = read("README.md");
  assert.match(readme, /Copyright © Satoshi Ltd\./);
  assert.match(readme, /\[GNU Affero General Public License, version 3\]\(LICENSE\) only/);
  assert.match(readme, /grant Satoshi Ltd\. a perpetual, worldwide, royalty-free, irrevocable license to use, modify, sublicense and relicense it/);
  for (const file of ["README.md", "SPEC.md"])
    assert.doesNotMatch(read(file), /PolyForm|non-commercial|not open source/i, file);
});

test("the Docker image carries the license label and copies only files the deploy scripts stage", () => {
  const dockerfile = read("deploy/Dockerfile");
  assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.licenses="${REF}"`));
  assert.doesNotMatch(dockerfile, /^COPY LICENSE/m);
});
