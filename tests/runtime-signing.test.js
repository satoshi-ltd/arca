import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

test(
  "ad-hoc hardened Node can load the shipped native image dependency",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "arca-signed-node-"),
    );
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const node = path.join(temporary, "bin", "node");
    await fs.mkdir(path.dirname(node));
    const libraries = path.resolve(
      path.dirname(await fs.realpath(process.execPath)),
      "../lib",
    );
    if (
      await fs.stat(libraries).then(
        () => true,
        () => false,
      )
    )
      await fs.symlink(libraries, path.join(temporary, "lib"), "dir");
    await fs.copyFile(process.execPath, node);
    await fs.chmod(node, 0o755);
    const signed = spawnSync(
      "codesign",
      [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--entitlements",
        path.join(root, "apps/desktop/src-tauri/Entitlements.plist"),
        node,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(signed.status, 0, signed.stderr || signed.error?.message);
    const image = spawnSync(
      node,
      [
        "-e",
        `
    const sharp = require(${JSON.stringify(path.join(root, "node_modules/sharp"))});
    sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
      .png().toBuffer().then(bytes => process.stdout.write(String(bytes.length)));
  `,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(image.status, 0, image.stderr || image.error?.message);
    assert.ok(Number(image.stdout) > 0);
  },
);
