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
test("site build uses package.json version without metadata, release.json when present, and requires an explicit RELEASE_JSON", async (t) => {
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
  const fallback = build();
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /expected assets for v0\.3\.1/);
  const fallbackHtml = await readFile(
    path.join(root, "site/dist/index.html"),
    "utf8",
  );
  for (const suffix of [
    "macos-arm64.dmg",
    "windows-x64.exe",
    "linux-x64.AppImage",
  ])
    assert.match(
      fallbackHtml,
      new RegExp(
        `href="https://github.com/satoshi-ltd/arca/releases/download/v0\\.3\\.1/arca-0\\.3\\.1-${suffix.replace(".", "\\.")}"`,
      ),
    );
  assert.doesNotMatch(fallbackHtml, /href="[^"]+\.apk"/);
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
  assert.match(missingOverride.stderr, /npm run site:release/);
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
test("read-release picks the newest complete release via the GitHub API", async () => {
  const { readRelease, resolveToken } =
    await import("../site/scripts/read-release.mjs");
  const complete = (version) => ({
    tag_name: `v${version}`,
    draft: false,
    assets: ["macos-arm64.dmg", "windows-x64.exe", "linux-x64.AppImage"].map(
      (suffix) => ({ name: `arca-${version}-${suffix}`, size: 100 }),
    ),
  });
  const calls = [];
  const fetch =
    (releases, ok = true) =>
    async (url, init) => {
      calls.push({ url, init });
      return {
        ok,
        status: ok ? 200 : 401,
        statusText: ok ? "OK" : "Unauthorized",
        json: async () => releases,
      };
    };
  const release = await readRelease({
    repo: "satoshi-ltd/arca",
    token: "t0ken",
    fetch: fetch([
      complete("0.3.4"),
      { ...complete("0.3.10"), draft: true },
      { ...complete("1.0.0"), tag_name: "latest" },
    ]),
  });
  assert.equal(release.tag_name, "v0.3.4");
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/satoshi-ltd/arca/releases?per_page=100",
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
  await assert.rejects(
    readRelease({
      repo: "satoshi-ltd/arca",
      token: "t",
      fetch: fetch([], false),
    }),
    /401 Unauthorized/,
  );
  await assert.rejects(
    readRelease({
      repo: "satoshi-ltd/arca",
      token: "t",
      fetch: fetch(
        [complete("0.3.4")].map((r) => ({
          ...r,
          assets: r.assets.slice(0, 2),
        })),
      ),
    }),
    /Missing desktop installer: linux-x64.AppImage/,
  );
  await assert.rejects(
    readRelease({ repo: "not a repo", token: "t", fetch: fetch([]) }),
    /Repository is required/,
  );
  assert.equal(resolveToken({ GITHUB_TOKEN: "from-env" }), "from-env");
  assert.equal(resolveToken({ GH_TOKEN: "gh", GITHUB_TOKEN: "x" }), "gh");
});

test("site masthead displays version without an alpha or early-access suffix", () => {
  const masthead = template.split("<header")[1].split("</header>")[0];
  assert.match(masthead, /\{\{VERSION\}\}/);
  assert.doesNotMatch(masthead, /alpha|early access/i);
});
