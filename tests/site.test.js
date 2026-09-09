import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { render } from "../site/scripts/build.mjs";
const template = await readFile(
  new URL("../site/index.html", import.meta.url),
  "utf8",
);
const asset = (suffix) => ({
  name: `arca-0.3.1-${suffix}`,
  size: 100,
  browser_download_url: `https://github.com/satoshi-ltd/arca/releases/download/v0.3.1/arca-0.3.1-${suffix}`,
});
const release = {
  tag_name: "v0.3.1",
  draft: false,
  assets: [asset("macos-arm64.dmg")],
};
test("site build reads site/release.json by default and explains missing metadata", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "arca-site-build-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "site/scripts"), { recursive: true });
  for (const file of [
    "scripts/build.mjs",
    "index.html",
    "styles.css",
    "assets/platforms.svg",
  ]) {
    await cp(
      new URL(`../site/${file}`, import.meta.url),
      path.join(root, "site", file),
      { recursive: true },
    );
  }
  await cp(
    new URL("../apps/desktop/src/assets", import.meta.url),
    path.join(root, "apps/desktop/src/assets"),
    { recursive: true },
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.3.1" }),
  );
  const env = { ...process.env };
  for (const key of [
    "RELEASE_JSON",
    "SITE_OUTPUT",
    "GITHUB_REPOSITORY",
    "SITE_URL",
    "APP_STORE_URL",
    "PLAY_STORE_URL",
  ])
    delete env[key];
  const build = (extra = {}, args = []) =>
    spawnSync(
      process.execPath,
      [path.join(root, "site/scripts/build.mjs"), ...args],
      { cwd: os.tmpdir(), env: { ...env, ...extra }, encoding: "utf8" },
    );
  const missing = build();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Published release metadata not found/);
  assert.match(missing.stderr, /npm run site:preview/);
  const preview = build({}, ["--preview"]);
  assert.equal(preview.status, 0, preview.stderr);
  await writeFile(
    path.join(root, "site/release.json"),
    JSON.stringify(release),
  );
  const normal = build();
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(
    await readFile(path.join(root, "site/dist/index.html"), "utf8"),
    /releases\/download\/v0\.3\.1/,
  );
  const explicit = path.join(root, "custom-release.json");
  await writeFile(
    explicit,
    JSON.stringify({ ...release, tag_name: "v0.3.0", assets: [] }),
  );
  const override = build({ RELEASE_JSON: explicit });
  assert.equal(override.status, 0, override.stderr);
  assert.doesNotMatch(
    await readFile(path.join(root, "site/dist/index.html"), "utf8"),
    /releases\/download\/v0\.3\.1/,
  );
  const missingOverride = build({
    RELEASE_JSON: path.join(root, "absent.json"),
  });
  assert.notEqual(missingOverride.status, 0);
  assert.match(missingOverride.stderr, /Published release metadata not found/);
});
test("downloads use actual GitHub release assets and Linux appears once", () => {
  const html = render(template, {
    ...release,
    assets: [
      ...release.assets,
      asset("windows-x64.exe"),
      asset("linux-x64.AppImage"),
      asset("linux-x64.deb"),
    ],
  });
  assert.match(
    html,
    /href="https:\/\/github.com\/satoshi-ltd\/arca\/releases\/download\/v0.3.1\/arca-0.3.1-linux-x64.AppImage"/,
  );
  assert.doesNotMatch(html, /\.deb|Coming soon|\{\{[A-Z_]+\}\}|<nav/);
  assert.equal((html.match(/Linux · AppImage/g) || []).length, 1);
});
test("missing assets never get guessed download links; generic stores are explicit defaults", () => {
  const html = render(template, release);
  assert.doesNotMatch(html, /href="[^"]+\.(apk|exe|deb|AppImage)"/);
  assert.match(html, /href="https:\/\/apps.apple.com"/);
  assert.match(html, /href="https:\/\/play.google.com\/store\/apps"/);
});
test("reject drafts, malformed versions and mismatched asset destinations", () => {
  for (const change of [{ draft: true }, { tag_name: "latest" }])
    assert.throws(() => render(template, { ...release, ...change }));
  for (const url of [
    "https://evil.example/app.dmg",
    "javascript:alert(1)",
    "https://github.com/satoshi-ltd/arca/releases/download/v0.2.3/arca-0.3.1-macos-arm64.dmg",
  ])
    assert.throws(() =>
      render(template, {
        ...release,
        assets: [{ ...release.assets[0], browser_download_url: url }],
      }),
    );
  assert.throws(() =>
    render(template, release, { appStore: "https://example.com/app" }),
  );
  assert.throws(() =>
    render(template, release, { playStore: "https://example.com/store" }),
  );
});
