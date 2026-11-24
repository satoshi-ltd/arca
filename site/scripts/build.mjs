import { readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

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
const text = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const json = (value) =>
  `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
export function questions(template) {
  return [
    ...template.matchAll(
      /<details(?: open)?>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g,
    ),
  ].map((match) => ({ question: text(match[1]), answer: text(match[2]) }));
}
export function seoFiles(siteUrl, published, slugs = []) {
  const origin = siteUrl ? publicUrl(siteUrl) : "";
  const day = published ? new Date(published) : null;
  const lastmod =
    day && !Number.isNaN(day.getTime())
      ? `<lastmod>${day.toISOString().slice(0, 10)}</lastmod>`
      : "";
  return {
    robots: `User-agent: *\nAllow: /\n${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ""}`,
    sitemap: origin
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["", ...slugs.map((slug) => `${slug}/`)].map((page) => `<url><loc>${escape(origin)}/${page}</loc>${lastmod}</url>`).join("")}</urlset>\n`
      : null,
  };
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
  const appStoreUrl = config.appStore ? publicUrl(config.appStore) : "";
  if (appStoreUrl && new URL(appStoreUrl).hostname !== "apps.apple.com")
    throw new Error("Invalid App Store URL");
  const playUrl = config.playStore ? new URL(config.playStore) : null;
  if (
    playUrl &&
    (playUrl.origin !== "https://play.google.com" ||
      playUrl.hash ||
      !(
        (playUrl.pathname === "/store/apps" && !playUrl.search) ||
        (playUrl.pathname === "/store/apps/details" &&
          playUrl.searchParams.get("id"))
      ))
  ) {
    throw new Error("Invalid Google Play URL");
  }
  const stores = [
    playUrl &&
      `<a class="store" href="${escape(playUrl.href)}">${icon("android")}<span>Google Play<small>Android</small></span><span class="download-arrow" aria-hidden="true">↗</span></a>`,
    appStoreUrl
      ? `<a class="store" href="${escape(appStoreUrl)}">${icon("apple")}<span>App Store<small>iPhone &amp; iPad</small></span><span class="download-arrow" aria-hidden="true">↗</span></a>`
      : playUrl &&
        `<span class="store store-soon">${icon("apple")}<span>App Store<small>iPhone &amp; iPad · Coming soon</small></span></span>`,
  ].filter(Boolean);
  const apk = assets.get(`arca-${version}-android.apk`);
  const origin = config.siteUrl ? publicUrl(config.siteUrl) : "";
  const absolute = (path) => (origin ? `${origin}/${path}` : path);
  const title = text(/<title>([\s\S]*?)<\/title>/.exec(template)?.[1] || "Arca");
  const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(template)?.[1] || "";
  const social = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", "Arca"],
    ["property", "og:title", title],
    ["property", "og:description", description],
    origin && ["property", "og:url", `${origin}/`],
    ["property", "og:image", absolute("assets/og-image.png")],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:alt", "Arca: your files, your devices. Folders, photos, music and movies on a hub you run."],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", absolute("assets/og-image.png")],
  ]
    .filter(Boolean)
    .map(([kind, key, value]) => `<meta ${kind}="${key}" content="${escape(text(value))}" />`)
    .join("\n    ");
  const faq = questions(template);
  const structured = [
    json({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Arca",
      description: text(description),
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "macOS, Windows, Linux, Android, Docker",
      softwareVersion: version,
      ...(origin ? { url: `${origin}/` } : {}),
      image: absolute("assets/og-image.png"),
      downloadUrl: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
      license: `https://github.com/${repository}/blob/main/LICENSE`,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@type": "Organization", name: "Satoshi Ltd.", url: "https://www.satoshi-ltd.com" },
    }),
    faq.length &&
      json({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faq.map((entry) => ({
          "@type": "Question",
          name: entry.question,
          acceptedAnswer: { "@type": "Answer", text: entry.answer },
        })),
      }),
  ]
    .filter(Boolean)
    .join("\n    ");
  const tokens = {
    VERSION: escape(version),
    RELEASE_NOTES: escape(
      release.body || "Published release notes appear here after deployment.",
    ),
    MAC_DOWNLOAD: link("macos-arm64.dmg", "Download for macOS", "apple", true),
    WINDOWS_DOWNLOAD: link("windows-x64.exe", "Windows · x64", "windows"),
    LINUX_DOWNLOAD: link("linux-x64.AppImage", "Linux · AppImage", "linux"),
    ANDROID_APK:
      apk && apk.size > 0
        ? `<div class="download-alternatives"><span class="eyebrow">${stores.length ? "Outside the store" : "Android"}</span><div class="download-alternatives-list">${link("android.apk", "Download Android APK", "android")}</div><small>Install directly, without a store account.</small></div>`
        : "",
    DOCKER_ICON: icon("docker"),
    SOCIAL: social,
    STRUCTURED_DATA: structured,
    ANDROID_ICON: icon("android"),
    MOBILE_ACCESS: stores.length
      ? `<div class="store-row">${stores.join("")}</div>`
      : '<p class="mobile-status">The Android and iOS apps are not in the app stores yet. They are still being qualified.</p>',
    SITE_LINKS: config.siteLinks || "",
    CANONICAL: config.siteUrl
      ? `<link rel="canonical" href="${escape(publicUrl(config.siteUrl))}/">`
      : "",
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in tokens)) throw new Error(`Unknown template token: ${key}`);
    return tokens[key];
  });
}

export const groups = ["Libraries", "Compare", "Guides"];
export function parsePage(slug, source) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`Invalid page name: ${slug}`);
  const title = /^<title>([^<]+)<\/title>\s*/.exec(source);
  if (!title) throw new Error(`${slug}: a page starts with its <title>`);
  let body = source.slice(title[0].length);
  const meta = {};
  for (let match; (match = /^<meta name="(description|group|label)" content="([^"]+)" \/>\s*/.exec(body)); body = body.slice(match[0].length))
    meta[match[1]] = match[2];
  for (const key of ["description", "group", "label"])
    if (!meta[key]) throw new Error(`${slug}: missing <meta name="${key}">`);
  if (/&#?\w+;/.test(title[1] + Object.values(meta).join("")))
    throw new Error(`${slug}: the title and metas are plain text, without HTML entities`);
  if (!groups.includes(meta.group)) throw new Error(`${slug}: unknown group ${meta.group}`);
  const section = body.indexOf("<h2");
  if ((body.match(/<h1>[^<]+<\/h1>/g) || []).length !== 1 || (section !== -1 && section < body.indexOf("<h1>")))
    throw new Error(`${slug}: the content has one <h1>, before any <h2>`);
  return { slug, title: title[1], ...meta, body };
}
const inline = (value) =>
  escape(value)
    .replace(/\//g, "&#47;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
export function changelogPage(markdown, repository = "satoshi-ltd/arca", limit = 30) {
  const entries = markdown
    .replace(/\r\n/g, "\n")
    .split(/^## /m)
    .slice(1, limit + 1)
    .map((entry) => {
      const [heading, ...lines] = entry.trim().split("\n");
      const [version, date] = heading.split(" — ");
      const items = lines.filter((line) => line.startsWith("- ")).map((line) => `<li>${inline(line.slice(2))}</li>`);
      const hub = lines.some((line) => /^Needs:.*\bhub redeploy\b/.test(line)) ? '\n<p class="fine">Needs an updated hub.</p>' : "";
      return `<section>\n<h2>${escape(version)}${date ? ` <small>${escape(date)}</small>` : ""}</h2>\n<ul>\n${items.join("\n")}\n</ul>${hub}\n</section>`;
    });
  return {
    slug: "changelog",
    title: "Arca changelog — what each version shipped",
    description: "Release notes for Arca, the free self-hosted cloud for your files, photos, music and movies: what changed in each of the latest versions.",
    group: "Guides",
    label: "Changelog",
    body: `<h1>Changelog</h1>\n<p class="lede">What each version of Arca shipped, newest first. The desktop app updates itself; a Docker hub updates when you pull the new image.</p>\n${entries.join("\n")}\n<p>Older versions are in the <a href="https://github.com/${repository}/blob/main/CHANGELOG.md">full changelog on GitHub</a>.</p>`,
  };
}
const appOrder = ["file-sync", "photos", "music", "movies"];
export function sorted(pages) {
  const rank = (page) => groups.indexOf(page.group) * 100 + (appOrder.indexOf(page.slug) + 1 || 99);
  return [...pages].sort((a, b) => rank(a) - rank(b));
}
export function siteLinks(pages, prefix = "", current = "") {
  const columns = groups
    .map((group) => {
      const links = pages
        .filter((page) => page.group === group)
        .map((page) => `<li><a href="${prefix}${page.slug}/"${page.slug === current ? ' aria-current="page"' : ""}>${escape(page.label)}</a></li>`);
      return links.length ? `<div><h2 class="eyebrow">${group}</h2><ul>${links.join("")}</ul></div>` : "";
    })
    .join("");
  return columns ? `<nav class="site-links wrap" aria-label="More about Arca">${columns}</nav>` : "";
}
export function renderPage(layout, page, pages, config = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(config.version)) throw new Error("Expected a version");
  const origin = config.siteUrl ? publicUrl(config.siteUrl) : "";
  const image = origin ? `${origin}/assets/og-image.png` : "../assets/og-image.png";
  const social = [
    ["property", "og:type", "article"],
    ["property", "og:site_name", "Arca"],
    ["property", "og:title", page.title],
    ["property", "og:description", page.description],
    origin && ["property", "og:url", `${origin}/${page.slug}/`],
    ["property", "og:image", image],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:alt", "Arca: your files, your devices. Folders, photos, music and movies on a hub you run."],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", page.title],
    ["name", "twitter:description", page.description],
    ["name", "twitter:image", image],
  ]
    .filter(Boolean)
    .map(([kind, key, value]) => `<meta ${kind}="${key}" content="${escape(value)}" />`)
    .join("\n    ");
  for (const [, , address] of page.body.matchAll(/href\s*=\s*(["']?)([^"'\s>]*)\1/gi)) {
    const local = /^\.\.\/(?:([a-z0-9-]+)\/)?(?:#[\w-]+)?$/.exec(address);
    if (!local && !/^(https:\/\/|#)/.test(address)) throw new Error(`${page.slug} has a link that is neither https, an anchor nor ../page/: ${address}`);
    if (local?.[1] && !pages.some((other) => other.slug === local[1])) throw new Error(`${page.slug} links to a page that does not exist: ${local[1]}`);
  }
  const tokens = {
    TITLE: escape(page.title),
    DESCRIPTION: escape(page.description),
    GROUP: escape(page.group),
    CONTENT: page.body,
    VERSION: escape(config.version),
    SOCIAL: social,
    SITE_LINKS: siteLinks(pages, "../", page.slug),
    CANONICAL: origin ? `<link rel="canonical" href="${escape(origin)}/${page.slug}/">` : "",
    STRUCTURED_DATA: origin
      ? json({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Arca", item: `${origin}/` },
            { "@type": "ListItem", position: 2, name: page.label, item: `${origin}/${page.slug}/` },
          ],
        })
      : "",
  };
  return layout.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in tokens)) throw new Error(`Unknown template token: ${key}`);
    return tokens[key];
  });
}
export async function readPages(directory, changelog, repository) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".html")).sort();
  const pages = [];
  for (const name of names) pages.push(parsePage(name.slice(0, -5), (await readFile(path.join(directory, name), "utf8")).replace(/\r\n/g, "\n")));
  return sorted([...pages, changelogPage(changelog, repository)]);
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
  const pages = await readPages(path.join(root, "site/pages"), await readFile(path.join(root, "CHANGELOG.md"), "utf8"), repository);
  const html = render(
    await readFile(path.join(root, "site/index.html"), "utf8"),
    release,
    {
      repository,
      siteLinks: siteLinks(pages),
      siteUrl: process.env.SITE_URL,
      appStore:
        process.env.APP_STORE_URL ||
        "https://apps.apple.com/us/app/arca-personal-drive/id6820444805",
      playStore:
        process.env.PLAY_STORE_URL ||
        "https://play.google.com/store/apps/details?id=com.satoshilimited.arca",
    },
  );
  if (!process.env.SITE_OUTPUT) await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, "assets"), { recursive: true });
  const sources = Object.fromEntries([
    ...["platforms.svg", "og-image.png", "apple-touch-icon.png"].map((name) => [name, path.join(root, "site/assets", name)]),
    ...["arca-icon.svg", "fonts/manrope.woff2", "fonts/geist-mono.woff2"].map((name) => [path.basename(name), path.join(root, "apps/desktop/src/assets", name)]),
  ]);
  const stamps = new Map();
  for (const [name, file] of Object.entries(sources))
    stamps.set(name, createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 10));
  const digest = (data) => createHash("sha256").update(data).digest("hex").slice(0, 10);
  const stamped = (text) =>
    text.replace(/assets\/([\w.-]+)(?=["')#])/g, (match, name) => {
      if (!stamps.has(name)) throw new Error(`The site references assets/${name}, which the build does not ship`);
      return `${match}?v=${stamps.get(name)}`;
    });
  const styles = stamped(await readFile(path.join(root, "site/styles.css"), "utf8"));
  const theme = await readFile(path.join(root, "site/theme.js"));
  const finished = (text) =>
    stamped(text)
      .replace(/href="((?:\.\.\/)?styles\.css)"/, `href="$1?v=${digest(styles)}"`)
      .replace(/src="((?:\.\.\/)?theme\.js)"/, `src="$1?v=${digest(theme)}"`);
  await writeFile(path.join(output, "index.html"), finished(html));
  for (const [, target] of html.matchAll(/href="([a-z0-9-]+)\/"/g))
    if (!pages.some((page) => page.slug === target)) throw new Error(`The home page links to a page that does not exist: ${target}`);
  const layout = await readFile(path.join(root, "site/page.html"), "utf8");
  for (const page of pages) {
    await mkdir(path.join(output, page.slug), { recursive: true });
    await writeFile(path.join(output, page.slug, "index.html"), finished(renderPage(layout, page, pages, { version: release.tag_name.slice(1), siteUrl: process.env.SITE_URL })));
  }
  await writeFile(path.join(output, "styles.css"), styles);
  await cp(path.join(root, "site/theme.js"), path.join(output, "theme.js"));
  for (const [name, file] of Object.entries(sources)) await cp(file, path.join(output, "assets", name));
  const seo = seoFiles(process.env.SITE_URL, release.published_at, pages.map((page) => page.slug));
  await writeFile(path.join(output, "robots.txt"), seo.robots);
  if (seo.sitemap) await writeFile(path.join(output, "sitemap.xml"), seo.sitemap);
  await writeFile(
    path.join(output, "_headers"),
    "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\n/assets/*\n  Cache-Control: public, max-age=604800\n",
  );
  console.log(
    `Built static site: ${output}${published ? "" : ` (expected assets for ${release.tag_name}; run npm run site:release for published metadata)`}`,
  );
}
