import fs from "node:fs";
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
import { fileURLToPath } from "node:url";
import os from "node:os";
import vm from "node:vm";
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
    "theme.js",
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
  const stale = path.join(root, "site/dist/assets/motion.js");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "retired");
  const fallback = build();
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fs.existsSync(stale), false, "files a previous build left behind are removed");
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
test("the Docker command never pins a version the registry may not have yet", () => {
  const html = render(template, release);
  assert.match(html, /docker pull satoshiltd\/arca:latest/);
  assert.doesNotMatch(html, /docker pull satoshiltd\/arca:\d/);
});
test("missing assets never get guessed download links, and stores and the APK appear only when they exist", () => {
  const html = render(template, release);
  assert.doesNotMatch(html, /href="[^"]+\.(apk|exe|deb|AppImage)"/);
  assert.doesNotMatch(html, /apps\.apple\.com|play\.google\.com|Download Android APK|Outside the store/);
  assert.match(html, /The Android and iOS apps are not in the app stores yet/);
  const stores = render(template, release, {
    appStore: "https://apps.apple.com/app/id1",
    playStore: "https://play.google.com/store/apps/details?id=com.arca",
  });
  assert.match(stores, /href="https:\/\/apps\.apple\.com\/app\/id1"/);
  assert.match(stores, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.arca"/);
  assert.doesNotMatch(stores, /not in the app stores yet/);
  const apk = render(template, { ...release, assets: [...release.assets, asset("android.apk")] });
  assert.match(apk, /href="[^"]+arca-0\.3\.1-android\.apk"/);
  assert.match(apk, /<span class="eyebrow">Android<\/span>/);
  assert.match(render(template, { ...release, assets: [...release.assets, asset("android.apk")] }, { playStore: "https://play.google.com/store/apps" }), /Outside the store/);
});
test("the page says it is free and names its license without claiming to be open source", async () => {
  const html = render(template, release);
  assert.match(html, /Free, on purpose/);
  assert.match(html, /Is Arca really free\?/);
  assert.match(html, /href="https:\/\/github\.com\/satoshi-ltd\/arca\/blob\/main\/LICENSE"[^>]*>PolyForm Strict License</);
  for (const mention of html.match(/[^<>]{0,20}open[- ]source/gi) || [])
    assert.match(mention, /not open source/, `unexpected open source claim: ${mention}`);
  assert.equal((html.match(/using it for a business or at work is not covered/g) || []).length, 2);
  assert.doesNotMatch(html, /You want to (use it for a business|share folders with other people)/);
  const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
  assert.match(license, /^Required Notice: Copyright /);
  assert.match(license, /# PolyForm Strict License 1\.0\.0/);
  assert.match(license, /other than distributing the software or making changes or new works based on the software/);
});
test("the installation note comes before the downloads and the page states what it really needs", () => {
  const html = render(template, release);
  assert.ok(html.indexOf('class="install-note"') > 0);
  assert.ok(html.indexOf('class="install-note"') < html.indexOf('class="download-grid"'));
  assert.doesNotMatch(html, /alpha/i);
  assert.match(html, /Needs a computer\s+you run as your hub/);
  assert.match(html, /30 days by default/);
  assert.match(html, /Restoring needs the hub to be reachable/);
});
test("the page never says a linked album keeps no copy on the phone, and its FAQ answers the hard questions", () => {
  const html = render(template, release);
  assert.doesNotMatch(html, /second Arca copy|without keeping/);
  assert.match(html, /keeps the complete shared folder in\s+app storage/);
  const questions = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  for (const question of [
    "Is Arca really free?",
    "What happens if my hub breaks?",
    "Is sync a backup?",
    "Who can see my data?",
    "How is Arca different from Dropbox, Nextcloud or Syncthing?",
  ])
    assert.ok(questions.includes(question), question);
  assert.equal((html.match(/<details open>/g) || []).length, 1);
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

const css = await readFile(new URL("../site/styles.css", import.meta.url), "utf8");
const themeSource = await readFile(
  new URL("../site/theme.js", import.meta.url),
  "utf8",
);
const runTheme = ({ systemDark, stored }) => {
  const listeners = { click: [] };
  const meta = {
    content: "",
    setAttribute(name, value) {
      this.content = value;
    },
  };
  const button = {
    label: "",
    setAttribute(name, value) {
      this.label = value;
    },
  };
  const root = { dataset: {} };
  const store = stored ? { "arca-theme": stored } : {};
  vm.runInNewContext(themeSource, {
    matchMedia: () => ({ matches: systemDark, addEventListener() {} }),
    localStorage: {
      getItem: (key) => store[key] ?? null,
      setItem: (key, value) => {
        store[key] = value;
      },
    },
    document: {
      documentElement: root,
      querySelector: (selector) =>
        selector === 'meta[name="theme-color"]'
          ? meta
          : selector === ".theme-btn"
            ? button
            : null,
      addEventListener: (type, fn) => {
        (listeners[type] = listeners[type] || []).push(fn);
      },
    },
  });
  return {
    root,
    meta,
    button,
    store,
    click: () =>
      listeners.click.forEach((fn) => fn({ target: { closest: () => ({}) } })),
  };
};
test("site offers a theme switch in the same form as the sibling sites", () => {
  assert.match(template, /<script src="theme\.js"><\/script>/);
  assert.equal((template.match(/<script\b/g) || []).length, 1);
  assert.match(template, /class="theme-btn"[\s\S]*class="sun"[\s\S]*class="moon"/);
  assert.ok(css.includes(':root:not([data-theme="light"])'));
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(css.includes(':root[data-theme="light"] .theme-btn .sun'));
  assert.doesNotMatch(template, /\sstyle="/);
});
test("theme follows the system until the reader picks one, then remembers the pick", () => {
  assert.equal(runTheme({ systemDark: true }).root.dataset.theme, "dark");
  assert.equal(runTheme({ systemDark: false }).root.dataset.theme, "light");
  assert.equal(
    runTheme({ systemDark: true, stored: "light" }).root.dataset.theme,
    "light",
  );
  assert.equal(
    runTheme({ systemDark: true, stored: "sepia" }).root.dataset.theme,
    "dark",
  );
  const page = runTheme({ systemDark: false });
  page.click();
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.store["arca-theme"], "dark");
  assert.equal(page.meta.content, "#0f1512");
  assert.equal(page.button.label, "Switch to light theme");
});
test("site build ships theme.js", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "arca-site-theme-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../site/scripts/build.mjs", import.meta.url))],
    { env: { ...process.env, SITE_OUTPUT: output }, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(path.join(output, "theme.js")));
});
test("anchor links scroll smoothly only for readers who allow motion", () => {
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*html \{\s*scroll-behavior: smooth;\s*\}\s*\}/);
  assert.equal((css.match(/scroll-behavior/g) || []).length, 1);
});
test("site keeps a sticky header with the version and a download link to a real section", () => {
  const header = template.split("<header")[1].split("</header>")[0];
  const targets = [...header.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
  assert.match(css, /\.masthead \{[^}]*position: sticky;[^}]*top: 0;/);
  assert.equal(targets.length, 1);
  assert.ok(template.includes(`id="${targets[0]}"`));
  assert.match(header, /class="nav-cta/);
  assert.doesNotMatch(header, /<ul/);
  assert.match(header, /\{\{VERSION\}\}/);
});

test("the site's light palette is the app's palette", async () => {
  const read = (file) => readFile(new URL(file, import.meta.url), "utf8");
  const [tokens, styles] = await Promise.all([
    read("../apps/desktop/src/tokens.css"),
    read("../site/styles.css"),
  ]);
  const light = (source) => source.split(/^(?::root)?\[data-theme="dark"\]/m)[0];
  const value = (source, name) =>
    light(source).match(new RegExp(`--${name}:\\s*(#[\\da-f]{6})`))?.[1];
  for (const [site, app] of [
    ["paper", "paper"],
    ["ink", "ink"],
    ["green", "green"],
    ["green-hover", "deep"],
    ["muted", "mute"],
  ])
    assert.equal(value(styles, site), value(tokens, app), `--${site}`);
  assert.match(await read("../site/index.html"), /name="theme-color" content="#f4f6f1"/);
});
