import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
