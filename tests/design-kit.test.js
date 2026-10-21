import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mobileTokens } from "../design/build.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) =>
  fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const pages = ["index.html", "desktop.html", "mobile.html", "auto.html", "proposals.html"];
const kitStyles = [read("design", "kit.css"), read("design", "mobile.css"), read("design", "auto.css")];

test("the design kit's mobile tokens are generated from the app palette and geometry", () => {
  assert.equal(
    read("design", "mobile-tokens.css"),
    mobileTokens(),
    "run `npm run design` after changing palette.js or design-tokens.js",
  );
});

test("design pages use the production stylesheets and only classes the app or kit defines", () => {
  const appMarkup =
    read("apps", "desktop", "src", "app.js") +
    read("apps", "desktop", "src", "index.html");
  const known = new Set(
    [
      ...[read("apps", "desktop", "src", "style.css"), ...kitStyles]
        .join("\n")
        .matchAll(/\.([a-zA-Z][\w-]*)/g),
    ].map((match) => match[1]),
  );
  for (const [, list] of appMarkup.matchAll(/class="([^"$]+)"/g))
    for (const name of list.split(/\s+/)) if (name) known.add(name);
  for (const kind of ["info", "warning", "error"]) known.add(`notice-${kind}`);
  for (const page of pages) {
    const html = read("design", page);
    assert.match(html, /href="\.\.\/apps\/desktop\/src\/tokens\.css"/, page);
    assert.match(html, /href="\.\.\/apps\/desktop\/src\/style\.css"/, page);
    assert.match(html, new RegExp(`class="kit-version">v${JSON.parse(read("package.json")).version.replaceAll(".", "\\.")} ·`), page);
    for (const [, list] of html.matchAll(/class="([^"]+)"/g))
      for (const name of list.split(/\s+/).filter(Boolean))
        assert.ok(known.has(name), `${page}: .${name} is not a production or kit class`);
  }
});

test("design pages carry no inline styles", () => {
  for (const page of fs.readdirSync(path.join(root, "design")).filter((name) => name.endsWith(".html")))
    assert.ok(!/\sstyle\s*=/i.test(read("design", page)), `${page}: move inline styles into kit.css`);
});

test("design styles take every colour and size from defined tokens", () => {
  const defined = new Set(
    [
      read("apps", "desktop", "src", "tokens.css"),
      read("design", "mobile-tokens.css"),
    ]
      .join("\n")
      .matchAll(/(--[\w-]+)\s*:/g),
  );
  const names = new Set([...defined].map((match) => match[1]));
  names.add("--columns");
  const sources = [
    ...kitStyles,
    ...pages.map((page) => read("design", page)),
  ].join("\n");
  for (const [, name] of sources.matchAll(/var\((--[\w-]+)/g))
    assert.ok(names.has(name), `${name} is not a defined token`);
  for (const css of kitStyles)
    assert.doesNotMatch(css, /(?<![\w-])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b(?![\w-])|\b(?:rgba?|hsla?)\(|[:\s](?:white|black)\b(?![\w-])/, "kit styles use tokens, not literal colours");
});

test("every design page links a favicon inside design/ that equals the project icon", () => {
  const source = fs.readFileSync(
    path.join(root, "apps", "desktop", "src", "assets", "arca-icon.svg"),
  );
  const found = fs
    .readdirSync(path.join(root, "design"))
    .filter((name) => name.endsWith(".html"));
  assert.deepEqual([...found].sort(), [...pages].sort());
  assert.equal(found.length, 5);
  for (const page of found) {
    const href = read("design", page).match(
      /<link rel="icon" href="([^"]+)"/,
    )?.[1];
    assert.ok(href, `${page} links no favicon`);
    assert.ok(!href.startsWith("."), `${page} favicon leaves design/`);
    const file = path.join(root, "design", href);
    assert.ok(fs.existsSync(file), `${page} favicon ${href} is missing`);
    assert.deepEqual(
      fs.readFileSync(file),
      source,
      "run `npm run design` to refresh design/favicon.svg",
    );
  }
});

test("the mobile Folders screens draw a pinned folder only in Favorites, with the Folders row's detail", () => {
  const lines = read("design", "mobile.html")
    .split("\n")
    .filter((line) => line.includes('<span class="m-title">Folders</span>') && line.includes('m-eyebrow">Favorites<'));
  assert.equal(lines.length, 3, "the phone, the Fold and the Fold behind its drawer all draw Favorites");
  for (const line of lines) {
    const [favorites, rest] = line.split('<span class="m-eyebrow">Folders</span>');
    assert.match(favorites, /<span class="m-row-title">documents<\/span><span class="m-caption">20 files · 14\.2 MB local<\/span>/, "a pinned folder keeps its files and size");
    assert.equal(rest.includes(">20 files"), false, "and is not drawn again below");
    assert.match(favorites, /<span class="m-row-title">invoices<\/span><span class="m-caption">documents › work<\/span>/, "a place keeps its location line");
    if (!line.includes("m-drawer-scrim")) assert.match(favorites, /Show all/);
    assert.doesNotMatch(rest, line.includes("m-drawer-scrim") ? /<span class="m-row-title">documents<\/span>/ : /<span class="m-row-title">(documents|photos|music)<\/span>/, "a pinned folder is absent from the sections below");
    if (!line.includes("m-drawer-scrim")) assert.doesNotMatch(rest, /m-eyebrow">Photos</, "Photos vanishes when its only folder is pinned");
  }
  const proposals = read("design", "proposals.html");
  assert.ok(!proposals.includes("UI-MOB-FAVORITES-MOVE"), "the shipped board is deleted");
  assert.doesNotMatch(read("design", "kit.css"), /kit-sp-/, "its kit-only styles go with it");
});
