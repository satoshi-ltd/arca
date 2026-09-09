import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function publicUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Expected a public HTTPS URL without credentials, query or fragment",
    );
  return url.href.replace(/\/$/, "");
}
export function expectedRelease(version, repository = "satoshi-ltd/arca") {
  const tag_name = `v${version}`;
  return {
    tag_name,
    draft: false,
    assets: ["macos-arm64.dmg", "windows-x64.exe", "linux-x64.AppImage"].map(
      (suffix) => {
        const name = `arca-${version}-${suffix}`;
        return {
          name,
          size: 1,
          browser_download_url: `https://github.com/${repository}/releases/download/${tag_name}/${name}`,
        };
      },
    ),
  };
}
export function render(template, release, config = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft)
    throw new Error("Expected a published versioned release");
  const version = release.tag_name.slice(1);
  const repository = config.repository || "satoshi-ltd/arca";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid repository");
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const icon = (name) =>
    `<svg class="platform-icon" aria-hidden="true" focusable="false"><use href="assets/platforms.svg#${name}"></use></svg>`;
  const link = (suffix, label, platform, primary = false) => {
    const name = `arca-${version}-${suffix}`;
    const asset = assets.get(name);
    const content = `${icon(platform)}<span>${label}</span>`;
    let destination;
    if (asset && asset.size > 0) {
      destination = publicUrl(asset.browser_download_url);
      const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
      if (destination !== expected)
        throw new Error(`Unexpected release asset URL: ${name}`);
    }
    return asset && asset.size > 0
      ? `<a class="button${primary ? " primary" : ""}" href="${escape(destination)}">${content}<span class="download-arrow" aria-hidden="true">↗</span></a>`
      : `<span class="button${primary ? " primary" : ""} link-pending" aria-disabled="true">${content}</span>`;
  };
  const appStoreUrl = publicUrl(config.appStore || "https://apps.apple.com");
  if (new URL(appStoreUrl).hostname !== "apps.apple.com")
    throw new Error("Invalid App Store URL");
  const playUrl = new URL(
    config.playStore || "https://play.google.com/store/apps",
  );
  if (
    playUrl.origin !== "https://play.google.com" ||
    playUrl.hash ||
    !(
      (playUrl.pathname === "/store/apps" && !playUrl.search) ||
      (playUrl.pathname === "/store/apps/details" &&
        playUrl.searchParams.get("id"))
    )
  ) {
    throw new Error("Invalid Google Play URL");
  }
  const appStore = `<a class="store" href="${escape(appStoreUrl)}">${icon("apple")}<span>App Store<small>iPhone &amp; iPad ↗</small></span></a>`;
  const play = `<a class="store" href="${escape(playUrl.href)}">${icon("android")}<span>Google Play<small>Android ↗</small></span></a>`;
  const tokens = {
    VERSION: escape(version),
    RELEASE_NOTES: escape(
      release.body || "Published release notes appear here after deployment.",
    ),
    MAC_DOWNLOAD: link("macos-arm64.dmg", "Download for macOS", "apple", true),
    WINDOWS_DOWNLOAD: link("windows-x64.exe", "Windows · x64", "windows"),
    LINUX_DOWNLOAD: link("linux-x64.AppImage", "Linux · AppImage", "linux"),
    ANDROID_DOWNLOAD: link("android.apk", "Download Android APK", "android"),
    DOCKER_ICON: icon("docker"),
    APP_STORE: appStore,
    PLAY_STORE: play,
    CANONICAL: config.siteUrl
      ? `<link rel="canonical" href="${escape(publicUrl(config.siteUrl))}/">`
      : "",
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in tokens)) throw new Error(`Unknown template token: ${key}`);
    return tokens[key];
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const version = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  const repository = process.env.GITHUB_REPOSITORY || "satoshi-ltd/arca";
  const releasePath =
    process.env.RELEASE_JSON || path.join(root, "site/release.json");
  const published = await readFile(releasePath, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    if (process.env.RELEASE_JSON)
      throw new Error(
        `Published release metadata not found: ${releasePath}. Run npm run site:release first (with GH_TOKEN or GitHub CLI access), or unset RELEASE_JSON to build from the package.json version.`,
      );
    return null;
  });
  const release = published
    ? JSON.parse(published)
    : expectedRelease(version, repository);
  const output = path.resolve(
    process.env.SITE_OUTPUT || path.join(root, "site/dist"),
  );
  const html = render(
    await readFile(path.join(root, "site/index.html"), "utf8"),
    release,
    {
      repository,
      siteUrl: process.env.SITE_URL,
      appStore: process.env.APP_STORE_URL,
      playStore: process.env.PLAY_STORE_URL,
    },
  );
  await mkdir(path.join(output, "assets"), { recursive: true });
  await writeFile(path.join(output, "index.html"), html);
  await cp(path.join(root, "site/styles.css"), path.join(output, "styles.css"));
  await cp(
    path.join(root, "site/assets/platforms.svg"),
    path.join(output, "assets/platforms.svg"),
  );
  for (const name of [
    "arca-icon.svg",
    "fonts/instrument-sans.woff2",
    "fonts/fragment-mono.woff2",
  ]) {
    await cp(
      path.join(root, "apps/desktop/src/assets", name),
      path.join(output, "assets", path.basename(name)),
    );
  }
  await writeFile(
    path.join(output, "_headers"),
    "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\n",
  );
  console.log(
    `Built static site: ${output}${published ? "" : ` (expected assets for ${release.tag_name}; run npm run site:release for published metadata)`}`,
  );
}
