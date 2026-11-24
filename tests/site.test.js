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
import { render, parsePage, renderPage, changelogPage, siteLinks, seoFiles, sorted } from "../site/scripts/build.mjs";
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
    "page.html",
    "pages",
    "styles.css",
    "theme.js",
    "assets",
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
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.3.1 — 2026-01-01\n\n- First.\n");
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
  assert.match(
    fallbackHtml,
    /<a class="store" href="https:\/\/apps\.apple\.com\/us\/app\/arca-personal-drive\/id6820444805"/,
  );
  assert.doesNotMatch(fallbackHtml, /store-soon/);
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
  fs.rmSync(path.join(root, "site/assets/card-photos.png"));
  const cardless = build();
  assert.notEqual(cardless.status, 0, "a page without its social card stops the build");
  assert.match(cardless.stderr, /Missing card-photos\.png: draw the social cards with npm run site:cards/);
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
  assert.doesNotMatch(render(template, release), /og:url|og:image:secure_url|<link rel="canonical"/, "a local build without SITE_URL claims no address");
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
  assert.match(html, /href="https:\/\/github\.com\/satoshi-ltd\/arca\/blob\/main\/LICENSE"[^>]*>PolyForm Strict License</);
  for (const mention of html.match(/[^<>]{0,20}open[- ]source/gi) || [])
    assert.match(mention, /not open source/, `unexpected open source claim: ${mention}`);
  const page = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
  assert.match(html, /Is Arca really free\?/);
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
  assert.match(html, /Restoring needs the hub\s+to be reachable/);
});
test("the page presents music libraries with the iPhone and Android Auto caveats", () => {
  const html = render(template, release).replace(/\s+/g, " ");
  assert.match(html, /<strong>Photos<\/strong><span>1,204 photos<\/span><b>›<\/b> <\/div> <div class="file-row"> <span class="folder-symbol small"><\/span ><strong>Music<\/strong><span>240 tracks<\/span>/);
  assert.match(html, /<h3>Set up your libraries\.<\/h3>/);
  assert.match(html, /<span>05<\/span> <div> <h3>Check how long history is kept\./);
  assert.match(html, /On Android, listen to your music on the phone or with Android Auto\./);
  assert.match(html, /on your computer, the web and Android\. Stream from the hub or download albums for the road; Android Auto plays them in the car\./);
  assert.match(html, /An iPhone keeps the whole music folder and opens tracks in other apps for now/);
  const cards = html.match(/<div class="feature-grid library-grid">[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(cards, /iPhone|Allow space/, "a card says what a library does; its limits are answered in the questions");
  assert.doesNotMatch(html, /Enable music library/, "folders become libraries with Set up as library…");
  assert.doesNotMatch(html, /m3u8/i, "the page stays non-technical");
});
test("the page presents the hub as four libraries in order and draws the TV among the devices", () => {
  const html = render(template, release).replace(/\s+/g, " ");
  assert.match(html, /<h3>Files\.<\/h3>[\s\S]*<h3>Photos\.<\/h3>[\s\S]*<h3>Music\.<\/h3>[\s\S]*<h3>Movies &amp; TV\.<\/h3>/);
  assert.match(html, /<text class="device-label" x="64" y="110">Your TV<\/text>/);
  assert.match(html, /A laptop, phone, tablet, TV and second server connect to a central hub that keeps your folders, libraries and history/);
  assert.match(html, /Libraries \+ history/);
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
test("the site distinguishes local media, streaming, video history and backup", () => {
  const html = render(template, release).replace(/\s+/g, " ");
  assert.match(html, /keep the whole video folder/);
  assert.match(html, /files changed through Arca/);
  assert.match(html, /Changes made directly on the hub’s disk have no video history/);
  assert.match(html, /Back up Movies &amp; TV separately/);
  assert.match(html, /An Android phone streams from the hub and downloads what you choose/);
  assert.doesNotMatch(html, /keeps no history|Every device streams from the hub|Each device plays its own copy/);
});
test("the page never says a linked album keeps no copy on the phone, and its FAQ answers the hard questions", () => {
  const html = render(template, release);
  assert.doesNotMatch(html, /second Arca copy|without keeping/);
  assert.match(html, /keeps the complete shared folder in\s+app storage/);
  const faq = new JSDOM(html).window.document.querySelector(".answers");
  assert.deepEqual(Array.from(faq.querySelectorAll("summary"), (summary) => summary.textContent), [
    "Do I need a dedicated server?",
    "What happens if my hub goes offline or breaks?",
    "How much space do I need on my phone?",
    "If I delete a photo on my phone, does Arca keep it?",
    "Can I use Arca away from home?",
    "Who can access my files?",
    "Can I share a folder with friends or family?",
    "Do I still need a backup?",
    "How does music work on each device?",
    "How is Arca different from Dropbox, Nextcloud or Syncthing?",
    "Can Arca replace Google Photos, iCloud or Plex?",
    "Is Arca really free?",
  ]);
  const privacy = faq.querySelectorAll("details")[5].textContent;
  for (const fact of [/checks GitHub for signed updates/, /opens Google Maps/, /not end-to-end encrypted/, /plain HTTP/]) assert.match(privacy, fact);
  const hero = new JSDOM(html).window.document.querySelector(".hero-copy");
  assert.match(hero.querySelector("h1").textContent.replace(/\s+/g, " "), /Free self-hosted cloud · No account · No telemetry Your files\.Your devices\./, "the heading says what Arca is");
  assert.match(hero.querySelector(".intro").textContent.replace(/\s+/g, " "), /folders, photos, music and movies.*no company server in the middle/);
  assert.equal(hero.querySelector(".setup-link").getAttribute("href"), "#setup", "the first screen never sends the reader off the page");
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
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(css.includes(':root[data-theme="light"] .theme-btn .sun'));
  assert.doesNotMatch(template, /\sstyle="/);
});
test("the site is dark until the reader picks a theme, then remembers the pick", () => {
  assert.equal(runTheme({ systemDark: true }).root.dataset.theme, "dark");
  assert.equal(runTheme({ systemDark: false }).root.dataset.theme, "dark", "a light system still opens the site dark");
  for (const file of ["../site/index.html", "../site/page.html"]) {
    const page = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(page, /<html lang="en" data-theme="dark">/, "dark without waiting for the script");
    assert.match(page, /<meta name="theme-color" content="#0c100e" \/>\s*<meta name="color-scheme" content="dark light" \/>/);
  }
  assert.doesNotMatch(themeSource + css, /prefers-color-scheme/, "nothing follows the system");
  assert.equal(
    runTheme({ systemDark: true, stored: "light" }).root.dataset.theme,
    "light",
  );
  assert.equal(
    runTheme({ systemDark: true, stored: "sepia" }).root.dataset.theme,
    "dark",
  );
  const page = runTheme({ systemDark: false });
  assert.equal(page.meta.content, "#0c100e");
  assert.equal(page.button.label, "Switch to light theme");
  page.click();
  assert.equal(page.root.dataset.theme, "light");
  assert.equal(page.store["arca-theme"], "light");
  assert.equal(page.meta.content, "#f6f8f7");
  assert.equal(page.button.label, "Switch to dark theme");
  page.click();
  assert.equal(page.store["arca-theme"], "dark");
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
test("every asset the built page and stylesheet reference carries the hash of its content, so a week-long cache never serves an old icon", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "arca-site-stamp-"));
  t.after(() => rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../site/scripts/build.mjs", import.meta.url))],
    { env: { ...process.env, SITE_OUTPUT: output, SITE_URL: "https://example.test" }, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const { createHash } = await import("node:crypto");
  const built = fs.readFileSync(path.join(output, "index.html"), "utf8") + fs.readFileSync(path.join(output, "styles.css"), "utf8");
  const cards = [...built.matchAll(/https:\/\/example\.test\/assets\/([\w.-]+)(\?v=)?/g)];
  assert.ok(cards.length >= 3 && cards.every((match) => match[1] === "og-image.png" && !match[2]), "the social card keeps one plain address, as link scrapers expect");
  const references = [...built.replace(/https:\/\/example\.test\/assets\/[\w.-]+/g, "").matchAll(/assets\/([\w.-]+)(\?v=([0-9a-f]+))?/g)];
  const names = new Set(references.map((match) => match[1]));
  for (const name of ["arca-icon.svg", "apple-touch-icon.png", "platforms.svg", "manrope.woff2", "geist-mono.woff2"]) assert.ok(names.has(name), name);
  for (const [text, name, , stamp] of references) {
    const expected = createHash("sha256").update(fs.readFileSync(path.join(output, "assets", name))).digest("hex").slice(0, 10);
    assert.equal(stamp, expected, `${text} is stamped with its content`);
  }
  assert.match(built, /assets\/platforms\.svg\?v=[0-9a-f]{10}#apple/);
  const hash = (file) => createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex").slice(0, 10);
  assert.ok(built.includes(`href="styles.css?v=${hash("styles.css")}"`), "the stylesheet's address follows its content");
  assert.ok(built.includes(`src="theme.js?v=${hash("theme.js")}"`), "and so does the theme script's");
  assert.match(fs.readFileSync(path.join(output, "_headers"), "utf8"), /\/assets\/\*\n  Cache-Control: public, max-age=604800/);
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
  assert.match(await read("../site/index.html"), /name="theme-color" content="#0c100e"/);
});

const source = (extra = "") =>
  `<title>A page — Arca</title>\n<meta name="description" content="What it is." />\n<meta name="group" content="Guides" />\n<meta name="label" content="A page" />\n<h1>A page</h1>\n<p>Text.</p>${extra}`;
test("a content page declares its title, description, group and label before its heading, or the build stops", () => {
  const page = parsePage("a-page", source());
  assert.deepEqual({ ...page, body: undefined }, { slug: "a-page", title: "A page — Arca", description: "What it is.", group: "Guides", label: "A page", body: undefined });
  assert.equal(page.body, "<h1>A page</h1>\n<p>Text.</p>");
  assert.throws(() => parsePage("A_Page", source()), /Invalid page name/);
  assert.throws(() => parsePage("a-page", source().replace(/<meta name="label"[^\n]*\n/, "")), /missing <meta name="label">/);
  assert.throws(() => parsePage("a-page", source().replace("Guides", "Misc")), /unknown group Misc/);
  assert.throws(() => parsePage("a-page", source().replace("<h1>A page</h1>\n", "")), /has one <h1>/);
  assert.throws(() => parsePage("a-page", source("<h1>Again</h1>")), /has one <h1>/);
  assert.throws(() => parsePage("a-page", source().replace("<h1>A page</h1>", "<h2>First</h2>\n<h1>A page</h1>")), /before any <h2>/);
  assert.equal(parsePage("a-page", source().replace("<h1>A page</h1>", '<div class="page-hero"><h1>A page</h1></div>')).label, "A page", "a page may open with its illustrated header");
  assert.throws(() => parsePage("a-page", source().slice(source().indexOf("<meta"))), /starts with its <title>/);
  for (const entity of ["Films &amp; shows.", "It&#39;s here."])
    assert.throws(() => parsePage("a-page", source().replace("What it is.", entity)), /plain text, without HTML entities/, entity);
  const entry = (slug, group) => ({ slug, group });
  assert.deepEqual(sorted([entry("docker", "Guides"), entry("movies", "Libraries"), entry("plex-alternative", "Compare"), entry("music", "Libraries"), entry("photos", "Libraries"), entry("file-sync", "Libraries")]).map((entry) => entry.slug), ["file-sync", "photos", "music", "movies", "plex-alternative", "docker"], "libraries keep the apps' order");
});
test("a content page gets its own address, social card, breadcrumb and the links to every other page", async () => {
  const layout = await readFile(new URL("../site/page.html", import.meta.url), "utf8");
  const pages = [parsePage("a-page", source('<p><a href="../other/">Other</a> <a href="../#download">Get it</a></p>')), parsePage("other", source().replace("Guides", "Compare").replace(/A page/g, "Other & more"))];
  const html = renderPage(layout, pages[0], pages, { version: "0.3.1", siteUrl: "https://example.test/" });
  const document = new JSDOM(html).window.document;
  assert.equal(document.title, "A page — Arca");
  assert.equal(document.querySelector('meta[name="description"]').content, "What it is.");
  assert.equal(document.querySelector('link[rel="canonical"]').href, "https://example.test/a-page/");
  assert.equal(document.querySelector('meta[property="og:url"]').content, "https://example.test/a-page/");
  assert.equal(document.querySelector('meta[property="og:image"]').content, "https://example.test/assets/card-a-page.png", "a page shares its own card");
  for (const [selector, value] of [['meta[property="og:image:secure_url"]', "https://example.test/assets/card-a-page.png"], ['meta[name="twitter:image"]', "https://example.test/assets/card-a-page.png"], ['meta[property="og:image:type"]', "image/png"], ['meta[property="og:locale"]', "en_US"], ['meta[name="twitter:card"]', "summary_large_image"]])
    assert.equal(document.querySelector(selector).content, value, selector);
  assert.match(document.querySelector('meta[name="twitter:image:alt"]').content, /^Arca: your files, your devices/);
  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.deepEqual(JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent).itemListElement.map((item) => item.item), ["https://example.test/", "https://example.test/a-page/"]);
  assert.deepEqual(Array.from(document.querySelectorAll(".site-links a"), (link) => [link.getAttribute("href"), link.textContent, link.getAttribute("aria-current")]), [["../other/", "Other & more", null], ["../a-page/", "A page", "page"]]);
  assert.equal(document.querySelector(".brand").getAttribute("href"), "../");
  assert.equal(document.querySelector(".nav-cta").getAttribute("href"), "../#download");
  assert.equal(document.querySelector(".release").textContent.trim(), "0.3.1");
  assert.doesNotMatch(html, /\{\{/);
  const local = renderPage(layout, pages[0], pages, { version: "0.3.1" });
  assert.doesNotMatch(local, /rel="canonical"|ld\+json|og:url|og:image:secure_url/, "without a public address the page claims none");
  assert.throws(() => renderPage(layout, parsePage("a-page", source('<a href="../missing/">x</a>')), pages, { version: "0.3.1" }), /links to a page that does not exist: missing/);
  for (const address of ["other/", "/other/", "../other/deeper/", "http://example.test/", "../other"])
    for (const link of [`<a href='${address}'>x</a>`, `<a HREF = "${address}">x</a>`, `<a href=${address}>x</a>`])
      assert.throws(() => renderPage(layout, parsePage("a-page", source(link)), pages, { version: "0.3.1" }), /neither https, an anchor nor \.\.\/page\//, link);
  for (const address of ["../", "../#download", "../other/#top", "#here", "https://example.test/a"])
    assert.doesNotThrow(() => renderPage(layout, parsePage("a-page", source(`<a href="${address}">x</a>`)), pages, { version: "0.3.1" }), address);
  assert.equal(document.querySelector('meta[property="og:image:width"]').content, "1200");
  assert.equal(siteLinks([]), "");
  assert.match(siteLinks(pages), /href="other\/"/);
});
test("the changelog page lists the newest versions for readers, without the maintainer's build notes", () => {
  const page = changelogPage("# Changelog\r\n\r\n## 0.3.1 — 2026-02-01\r\n\r\n- Fixed `sync` for <b> & **more**.\r\n- Second, see (site/assets/fonts).\r\n\r\nNeeds: native build · hub redeploy\r\n\r\n## 0.3.0 — 2026-01-01\n\n- Older.\n\nNeeds: desktop build\n\n## 0.2.9 — 2025-12-01\n\n- Oldest.\n", "satoshi-ltd/arca", 2);
  assert.equal(page.slug, "changelog");
  assert.match(page.body, /^<h1>Changelog<\/h1>/);
  assert.match(page.body, /<h2>0\.3\.1 <small>2026-02-01<\/small><\/h2>\n<ul>\n<li>Fixed <code>sync<\/code> for &lt;b&gt; &amp; <strong>more<\/strong>\.<\/li>\n<li>Second, see \(site&#47;assets&#47;fonts\)\.<\/li>\n<\/ul>\n<p class="fine">Needs an updated hub\.<\/p>/);
  assert.equal((page.body.match(/Needs an updated hub/g) || []).length, 1, "only a version that needs the hub updated says so");
  assert.doesNotMatch(page.body, /assets\//, "release notes never read as an asset address to stamp");
  assert.match(page.body, /<h2>0\.3\.0 /);
  assert.doesNotMatch(page.body, /Needs:|native build|desktop build|0\.2\.9|Oldest/);
  assert.match(page.body, /href="https:\/\/github\.com\/satoshi-ltd\/arca\/blob\/main\/CHANGELOG\.md"/);
  assert.equal(parsePage("changelog", `<title>${page.title}</title>\n<meta name="description" content="${page.description}" />\n<meta name="group" content="${page.group}" />\n<meta name="label" content="${page.label}" />\n${page.body}`).label, "Changelog");
});
test("the sitemap lists the home page and every content page", () => {
  const { sitemap } = seoFiles("https://example.test", "2026-02-01T00:00:00Z", ["photos", "docker"]);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc><lastmod>2026-02-01<\/lastmod>/g)].map((match) => match[1]), ["https://example.test/", "https://example.test/photos/", "https://example.test/docker/"]);
  assert.equal((seoFiles("https://example.test").sitemap.match(/<url>/g) || []).length, 1);
});
test("the built site has a page for every library, comparison and guide, each reachable, stamped and honest", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "arca-site-pages-"));
  t.after(() => rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../site/scripts/build.mjs", import.meta.url))], { env: { ...process.env, SITE_OUTPUT: output, SITE_URL: "https://example.test" }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const slugs = fs.readdirSync(new URL("../site/pages", import.meta.url)).filter((name) => name.endsWith(".html")).map((name) => name.slice(0, -5)).concat("changelog").sort();
  assert.deepEqual(slugs, ["changelog", "docker", "dropbox-alternative", "file-sync", "google-photos-alternative", "movies", "music", "nextcloud-alternative", "photos", "plex-alternative", "remote-access", "syncthing-alternative"]);
  const home = new JSDOM(fs.readFileSync(path.join(output, "index.html"), "utf8")).window.document;
  assert.deepEqual(Array.from(home.querySelectorAll(".site-links a"), (link) => link.getAttribute("href")).sort(), slugs.map((slug) => `${slug}/`));
  assert.deepEqual(Array.from(home.querySelectorAll(".site-links h2"), (heading) => heading.textContent), ["Libraries", "Compare", "Guides"]);
  const sitemap = fs.readFileSync(path.join(output, "sitemap.xml"), "utf8");
  const titles = new Set([home.title]);
  const descriptions = new Set();
  const css = fs.readFileSync(path.join(output, "styles.css"), "utf8");
  for (const slug of slugs) {
    const html = fs.readFileSync(path.join(output, slug, "index.html"), "utf8");
    const document = new JSDOM(html).window.document;
    assert.ok(sitemap.includes(`<loc>https://example.test/${slug}/</loc>`), `${slug} is in the sitemap`);
    assert.equal(document.querySelector('link[rel="canonical"]').getAttribute("href"), `https://example.test/${slug}/`);
    assert.equal(document.querySelectorAll("h1").length, 1, `${slug} has one heading`);
    assert.ok(document.title.length <= 60 && document.title.endsWith("— Arca") || slug === "changelog", `${slug}: ${document.title.length}-character title`);
    const description = document.querySelector('meta[name="description"]').content;
    assert.ok(description.length >= 110 && description.length <= 160, `${slug}: ${description.length}-character description`);
    assert.ok(!titles.has(document.title) && !descriptions.has(description), `${slug} repeats no other page's title or description`);
    titles.add(document.title);
    descriptions.add(description);
    assert.match(html, /href="\.\.\/styles\.css\?v=[0-9a-f]{10}"/);
    assert.match(html, /src="\.\.\/theme\.js\?v=[0-9a-f]{10}"/);
    assert.match(html, /href="\.\.\/assets\/arca-icon\.svg\?v=[0-9a-f]{10}"/);
    assert.ok(html.includes(`<meta name="twitter:image" content="https://example.test/assets/card-${slug}.png" />`), `${slug}: its own card, at a plain address`);
    assert.ok(fs.existsSync(path.join(output, "assets", `card-${slug}.png`)), `${slug}: the card ships`);
    assert.doesNotMatch(html, /\sstyle="/);
    if (slug === "changelog") continue;
    assert.doesNotMatch(html, /\{\{/);
    for (const link of document.querySelectorAll('a[href^="../"]')) {
      const target = link.getAttribute("href").slice(3).split("#")[0];
      assert.ok(fs.existsSync(path.join(output, target, "index.html")), `${slug} links to ${target || "the home page"}`);
    }
    const text = document.querySelector(".doc").textContent.replace(/\s+/g, " ");
    for (const claim of text.match(/[^.]*end-to-end[^.]*/g) || []) assert.match(claim, /not end-to-end encrypted/, `${slug}: ${claim}`);
    assert.doesNotMatch(text, /m3u8|alpha|beta/i, `${slug} stays non-technical and unlabelled`);
    for (const name of new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))))
      assert.ok(css.includes(`.${name}`), `${slug} uses .${name}, which the stylesheet defines`);
  }
  const page = (slug) => new JSDOM(fs.readFileSync(path.join(output, slug, "index.html"), "utf8")).window.document.querySelector(".doc").textContent.replace(/\s+/g, " ");
  for (const slug of slugs.filter((name) => name.endsWith("-alternative"))) {
    const document = new JSDOM(fs.readFileSync(path.join(output, slug, "index.html"), "utf8")).window.document;
    assert.equal(document.querySelectorAll('.compare thead th[scope="col"]').length, 2, `${slug} compares Arca with one product`);
    assert.equal(document.querySelectorAll('.compare tbody th[scope="row"]').length, document.querySelectorAll(".compare tbody tr").length, `${slug} names every row`);
    assert.match(page(slug), /Why choose Arca .* What Arca leaves out, on purpose/, `${slug} leads with Arca's case and still states its limits`);
    assert.doesNotMatch(page(slug) + document.querySelector('meta[name="description"]').content + document.title, /better choice|does better|You need open-source/i, `${slug} never argues for the other product, in its search snippet either`);
    assert.match(page(slug), /stays? (yours|on your own (hardware|devices))/, `${slug} leads with who owns the data`);
    for (const mention of page(slug).match(/[^.]{0,40}open[- ]source/gi) || []) assert.doesNotMatch(mention, /Arca (is|as) open/i);
  }
  assert.match(page("docker"), /image: satoshiltd\/arca:latest/);
  assert.doesNotMatch(page("docker"), /satoshiltd\/arca:\d/, "the guide never pins a version the registry may not have yet");
  assert.match(page("docker"), /"127\.0\.0\.1:17831:17831"/, "the guide publishes the port on the server alone until the reader chooses a route");
  assert.match(page("remote-access"), /Arca has no public relay/);
  assert.match(page("syncthing-alternative"), /Arca has no public relay: you choose the route\./);
  assert.doesNotMatch(page("syncthing-alternative"), /a server you do not run/, "a private network may relay, so the page promises no path");
  assert.doesNotMatch(page("nextcloud-alternative"), /work the same everywhere|nothing else to set up/);
  assert.match(page("photos"), /keeps the complete shared folder in Arca’s storage/);
  assert.match(page("music"), /An iPhone keeps the whole music folder and browses it, but opens tracks in other apps for now/);
  assert.match(page("movies"), /never re-encodes video/);
  assert.match(page("movies"), /full backup skips video libraries/);
  assert.match(page("file-sync"), /Sync is not a backup/);
  for (const slug of ["file-sync", "photos", "music", "movies"]) {
    const library = new JSDOM(fs.readFileSync(path.join(output, slug, "index.html"), "utf8")).window.document;
    assert.ok(library.querySelector(".page-hero h1") && library.querySelector('.page-hero .button.primary[href="../#download"]'), `${slug} opens with its heading and a download button`);
    assert.match(library.querySelector(".page-hero .page-scene").getAttribute("aria-label"), /^Illustration of /, `${slug} draws its library`);
    assert.equal(library.querySelector(".page-scene").getAttribute("role"), "img", `${slug}: a screen reader hears the label, not every sample row`);
    for (const mark of library.querySelectorAll(".feature-number")) assert.ok(mark.querySelector("svg[aria-hidden]") || mark.getAttribute("aria-hidden"), `${slug}: a card's icon is decoration`);
    assert.ok(library.querySelector(".page-scene .preview-window .preview-heading strong").textContent, `${slug} draws an Arca window`);
    assert.equal(library.querySelectorAll(".feature-grid article .feature-number").length, 3, `${slug} has three cards with an icon`);
    assert.equal(library.querySelectorAll("img").length, 2, `${slug} shows no screenshot, only the mark in the header and footer`);
  }
  assert.match(page("plex-alternative"), /Plex’s remote streaming, a paid feature/);
  for (const slug of ["plex-alternative", "movies", "photos", "google-photos-alternative", "nextcloud-alternative", "syncthing-alternative"])
    assert.ok(new JSDOM(fs.readFileSync(path.join(output, slug, "index.html"), "utf8")).window.document.querySelector('.doc a[href="https://arca-tv.satoshi-ltd.com/"]'), `${slug} links arca TV where it names it`);
  assert.match(page("docker"), /ssh -L 17831:127\.0\.0\.1:17831/, "a server without a screen still reaches the wizard");
  assert.match(page("docker"), /cap_drop: - ALL/, "the guide's container is as restricted as the repository's");
  assert.match(page("remote-access"), /every device arrives over plain HTTP from the proxy\. If pairing is refused, turn on Settings → Network → Allow HTTP connections/);
  assert.deepEqual(Array.from(home.querySelectorAll(".site-links div:first-child a"), (link) => link.textContent), ["File sync", "Photos", "Music", "Movies & TV"]);
  assert.match(home.querySelector(".answers").textContent, /Movies, and music on Android, stream from the hub instead/);
});

test("every page has a drawn social card that matches its current heading", async () => {
  const { cards, sitePages } = await import("../site/scripts/cards.mjs");
  const drawn = JSON.parse(fs.readFileSync(new URL("../site/cards.json", import.meta.url), "utf8"));
  const expected = cards(await sitePages());
  assert.deepEqual(Object.keys(drawn).sort(), expected.map((card) => card.file).sort());
  for (const card of expected) {
    assert.equal(drawn[card.file], card.key, `${card.file} is stale: run CHROME=… npm run site:cards`);
    const png = fs.readFileSync(new URL(`../site/assets/${card.file}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], `${card.file} is 1200×630`);
    assert.ok(png.length < 200000, `${card.file} stays light`);
    assert.doesNotMatch(card.html, /#f6f8f7/, "cards are drawn on the dark palette");
  }
  assert.match(expected[0].html, /<h1>Your files\.<b>Your devices\.<\/b><\/h1>/);
  assert.match(expected.find((card) => card.file === "card-movies.png").html, /<div class="eye">Arca \/ Libraries<\/div>\n<h1>Your own movies and shows, on every screen<\/h1>/);
  assert.match(cards([{ slug: "a", group: "Guides", body: "<h1>Films &amp;\n  shows</h1>" }])[1].html, /<h1>Films &amp; shows<\/h1>/, "a heading is drawn as it reads, not with its entity spelled out");
  assert.notEqual(cards([{ slug: "a", group: "Guides", body: "<h1>One</h1>" }])[1].key, cards([{ slug: "a", group: "Guides", body: "<h1>Two</h1>" }])[1].key, "a new heading asks for a new card");
});
