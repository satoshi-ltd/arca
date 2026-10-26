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
import { JSDOM } from "jsdom";
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await mkdir(path.join(root, "site/scripts"), { recursive: true });
  for (const file of [
    "scripts/build.mjs",
    "index.html",
    "styles.css",
    "theme.js",
    "assets/platforms.svg",
    "assets/og-image.png",
    "assets/apple-touch-icon.png",
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
  assert.equal(await readFile(path.join(root, "site/dist/robots.txt"), "utf8"), "User-agent: *\nAllow: /\n", "without SITE_URL robots.txt names no sitemap");
  assert.equal(fs.existsSync(path.join(root, "site/dist/sitemap.xml")), false);
  const published = build({ SITE_URL: "https://arca.example.com" });
  assert.equal(published.status, 0, published.stderr);
  assert.match(await readFile(path.join(root, "site/dist/robots.txt"), "utf8"), /^Sitemap: https:\/\/arca\.example\.com\/sitemap\.xml$/m);
  assert.match(await readFile(path.join(root, "site/dist/sitemap.xml"), "utf8"), /<loc>https:\/\/arca\.example\.com\/<\/loc>/);
  for (const name of ["og-image.png", "apple-touch-icon.png"]) assert.ok(fs.existsSync(path.join(root, "site/dist/assets", name)), name);
  assert.match(await readFile(path.join(root, "site/dist/_headers"), "utf8"), /\/assets\/\*\n  Cache-Control: public, max-age=604800/);
});
test("search engines and link previews get a title, description, social card and structured data that match the page", () => {
  const html = render(template, release, { siteUrl: "https://arca.example.com" });
  const title = /<title>([^<]+)<\/title>/.exec(html)[1];
  assert.ok(title.length <= 70, `title stays readable in results: ${title.length}`);
  assert.match(title, /self-hosted/i);
  const description = /<meta\s+name="description"\s+content="([^"]+)"/.exec(html)[1];
  assert.ok(description.length >= 120 && description.length <= 160, `description length ${description.length}`);
  assert.match(html, /<link rel="canonical" href="https:\/\/arca\.example\.com\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/arca\.example\.com\/assets\/og-image\.png" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/arca\.example\.com\/" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon\.png" \/>/);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  const app = blocks.find((block) => block["@type"] === "SoftwareApplication");
  assert.equal(app.softwareVersion, "0.3.1");
  assert.deepEqual(app.offers, { "@type": "Offer", price: "0", priceCurrency: "USD" });
  const faq = blocks.find((block) => block["@type"] === "FAQPage");
  const summaries = [...template.matchAll(/<summary>([^<]+)<\/summary>/g)].map((match) => match[1].replace(/&amp;/g, "&")).filter((question) => !question.startsWith("Release notes"));
  assert.deepEqual(faq.mainEntity.map((entry) => entry.name), summaries, "the structured FAQ is the page's own questions, in order");
  assert.ok(faq.mainEntity.every((entry) => entry.acceptedAnswer.text.length > 40 && !/[<>]/.test(entry.acceptedAnswer.text)));
  assert.doesNotMatch(render(template, release), /og:url|<link rel="canonical"/, "a local build without SITE_URL claims no address");
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
test("the desktop card lists Linux before Windows under its rule, without a label", () => {
  const html = render(template, release);
  assert.ok(html.indexOf("Linux · AppImage") < html.indexOf("Windows · x64"));
  assert.doesNotMatch(html, /Also for your desktop/);
  assert.match(html, /<div class="card-extra">\s*<div class="download-alternatives-list">/);
  assert.match(css, /\.download-alternatives-list \{[^}]*flex-wrap: wrap;/);
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
  const playOnly = render(template, release, { playStore: "https://play.google.com/store/apps/details?id=com.arca" });
  assert.match(playOnly, /class="store store-soon"[^>]*>[\s\S]*?Coming soon/);
  assert.doesNotMatch(stores, /Coming soon/);
  assert.ok(stores.indexOf("Google Play") < stores.indexOf("App Store"));
  assert.match(css, /\.store-soon \{[^}]*border-style: dashed;/);
  for (const store of stores.match(/<a class="store"[\s\S]*?<\/a>/g)) assert.match(store, /<span class="download-arrow" aria-hidden="true">↗<\/span><\/a>$/, "a store button ends in the same arrow as every other button");
  assert.doesNotMatch(playOnly.match(/<span class="store store-soon">[\s\S]*?<\/span><\/span>/)[0], /↗/, "Coming soon is not a link and has no arrow");
  assert.doesNotMatch(playOnly, /not in the app stores yet|<a class="store"[^>]*apps\.apple/);
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
  const page = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
  assert.equal((page.match(/using it for a business or at work is not covered/g) || []).length, 2);
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
test("the page presents music libraries with the iPhone and Android Auto caveats", () => {
  const html = render(template, release).replace(/\s+/g, " ");
  assert.match(html, /<strong>Photos<\/strong><span>1,204 photos<\/span><b>›<\/b> <\/div> <div class="file-row"> <span class="folder-symbol small"><\/span ><strong>Music<\/strong><span>240 tracks<\/span>/);
  assert.match(html, /<h3>Set up your libraries\.<\/h3>/);
  assert.match(html, /<span>05<\/span> <div> <h3>Check how long history is kept\./);
  assert.match(html, /play your music and watch your movies\. In the car, Android Auto plays your music\./);
  assert.match(html, /<summary>How does music work\?<\/summary>/);
  assert.match(html, /iPhone browses it and opens tracks in other apps for now/);
  assert.match(html, /Unknown sources turned on in Android Auto’s developer settings/);
  assert.match(html, /playlists you make are saved as ordinary files in that folder/);
  assert.doesNotMatch(html, /Enable music library/, "folders become libraries with Set up as library…");
  assert.doesNotMatch(html, /m3u8/i, "the page stays non-technical");
});
test("the page presents the hub as four libraries in order and draws the TV among the devices", () => {
  const html = render(template, release).replace(/\s+/g, " ");
  assert.match(html, /<h3>Files\.<\/h3>[\s\S]*<h3>Photos\.<\/h3>[\s\S]*<h3>Music\.<\/h3>[\s\S]*<h3>Movies &amp; TV\.<\/h3>/);
  assert.match(html, /<text class="device-label" x="64" y="110">Your TV<\/text>/);
  assert.match(html, /A laptop, phone, tablet, TV and second server connect to a central hub that keeps your folders, libraries and history/);
  assert.match(html, /Libraries \+ history/);
  assert.match(html, /<summary>How do Movies &amp; TV work\?<\/summary>/);
  assert.match(html, /sends the titles and years of your movies and shows to TMDB/, "the privacy answer names the only outside lookup");
  assert.ok(html.indexOf("01 / One hub. Four libraries.") < html.indexOf("02 / One person. More than one device."));
  assert.ok(html.indexOf("03 / Bring your devices together") < html.indexOf("Free, on purpose"));
  assert.ok(html.indexOf("Free, on purpose") < html.indexOf('id="download"'));
});
test("the downloads are four cards in one grid: desktop, mobile, Docker and arca TV", () => {
  const html = render(template, release);
  const grid = html.slice(html.indexOf('class="download-grid"'), html.indexOf('class="release-notes"'));
  assert.equal((grid.match(/<article class="download-card/g) || []).length, 4);
  assert.ok(grid.indexOf("Arca for desktop") < grid.indexOf("Arca for mobile"));
  assert.ok(grid.indexOf("Arca with Docker") < grid.indexOf("Arca for TV"));
  assert.equal((grid.match(/download-card mac-card/g) || []).length, 1, "only the desktop card is highlighted");
  assert.ok(grid.indexOf("mac-card") < grid.indexOf("Arca for desktop"));
  assert.ok(grid.indexOf("download-card mobile-card") < grid.indexOf("Arca for mobile"), "mobile has its own panel");
  assert.equal((grid.match(/download-card mobile-card/g) || []).length, 1);
  assert.match(css, /\.mobile-card \{\n  background: var\(--panel\);/);
  assert.match(css, /\.store-row \{\n  display: flex;\n  flex-wrap: wrap;/, "the store buttons sit side by side and wrap when narrow");
  for (const card of grid.split("<article").slice(1)) {
    const parts = [...card.matchAll(/class="(card-top|card-action|card-hint|card-extra)"|<h3>|<p>/g)].map((match) => match[1] || match[0]);
    assert.deepEqual(parts.slice(0, 6), ["card-top", "<h3>", "<p>", "card-action", "card-hint", "card-extra"], "every card has the same parts in the same order");
    const words = card.match(/<p>([\s\S]*?)<\/p>/)[1].trim().split(/\s+/).length;
    assert.ok(words >= 17 && words <= 24, `a card paragraph runs about two lines (${words} words)`);
  }
  assert.match(css, /\.download-card \{\n  display: grid;\n  grid-row: span 6;\n  grid-template-rows: subgrid;/, "the parts line up across a row");
  const docker = grid.slice(grid.indexOf("Arca with Docker"), grid.indexOf("Arca for TV"));
  assert.match(docker, /<small class="card-hint">Or run <code>docker pull satoshiltd\/arca:latest<\/code><\/small>/, "the command is the Docker card's one-line hint");
  assert.match(css, /\.card-hint code \{\n  display: inline;\n  margin: 0;\n  padding: 0;\n  background: none;/, "it reads as a hint, not a chip");
  assert.match(css, /\.store \{[^}]*flex: 1 1 210px;/);
  assert.match(css, /\.store \{\n  border: 1px solid var\(--line\);\n  border-radius: 9px;\n  background: var\(--surface\);/, "a store button stands out on the mobile panel");
  assert.match(css, /\.store-soon \{\n  border-style: dashed;\n  background: transparent;/, "Coming soon stays a dashed outline");
  assert.doesNotMatch(grid, /card-title/, "titles stay plain, without icons");
  assert.match(grid, /href="https:\/\/arca-tv\.satoshi-ltd\.com\/"\s*><svg class="platform-icon"[^>]*><use href="assets\/platforms\.svg#android"><\/use><\/svg><span>Visit arca TV<\/span\s*><span class="download-arrow"/);
  assert.equal((grid.match(/class="button card-button"/g) || []).length, 2);
  assert.match(css, /\.card-button \{\s*align-self: stretch;/, "every card's main action spans the card");
  assert.match(grid, /docker pull satoshiltd\/arca:latest/);
});
test("every download card has exactly the six parts its subgrid spans, whatever the stores and assets", () => {
  const apk = { ...release, assets: [...release.assets, asset("android.apk")] };
  const play = { playStore: "https://play.google.com/store/apps/details?id=com.arca" };
  for (const [value, stores] of [[release, {}], [release, play], [apk, {}], [apk, { ...play, appStore: "https://apps.apple.com/app/id1" }]]) {
    const cards = new JSDOM(render(template, value, stores)).window.document.querySelectorAll(".download-card");
    assert.equal(cards.length, 4);
    for (const card of cards) assert.equal(card.children.length, 6, card.querySelector("h3").textContent);
  }
});
test("an ownership row lines up with the section heading columns above it", () => {
  assert.match(css, /\.ownership \{[^}]*grid-template-columns: 1\.2fr 1fr;[^}]*gap: 0 80px;/);
  assert.match(css, /\.section-heading \{[^}]*grid-template-columns: 1\.2fr 1fr;[^}]*gap: 0 80px;/);
  const narrowGap = (selector) => {
    let last = null;
    for (const block of css.matchAll(/@media \(max-width: 1000px\) \{([\s\S]*?)\n\}/g)) if (new RegExp(`${selector}[^{]*\\{[^}]*gap: 0 40px`).test(block[1])) last = block.index;
    return last;
  };
  assert.ok(narrowGap("\\.ownership") > css.search(/^\.ownership \{/m), "the narrower gap comes after the base rule, so it wins between 721 and 1000 px");
  assert.ok(narrowGap("\\.section-heading") > css.search(/^\.section-heading \{/m));
});
test("the page never promises the backup or offline use for Movies & TV", () => {
  const html = render(template, release).replace(/\s+/g, " ");
  assert.match(html, /it keeps no history and the backup skips it, so keep your own copy of your video files/);
  assert.match(html, /it does not include Movies &amp; TV/);
  assert.match(html, /Movies &amp; TV and everything on arca TV stream from the hub, so they need it, except a title you downloaded beforehand/);
  const intro = html.match(/<p class="intro">([\s\S]*?)<\/p>/)[1];
  assert.doesNotMatch(intro, /offline/, "the hero promises no offline use, so it never covers Movies & TV");
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
  t.after(() => rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
