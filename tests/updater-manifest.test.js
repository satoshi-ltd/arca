import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  UPDATER_TARGETS,
  updaterManifest,
} from "../scripts/updater-manifest.js";

const box = (comment, { prefix = "trusted comment: ", signature = 74, global = 64 } = {}) =>
  Buffer.from(
    [
      "untrusted comment: signature from tauri secret key",
      Buffer.alloc(signature, 1).toString("base64"),
      `${prefix}${comment}`,
      Buffer.alloc(global, 2).toString("base64"),
      "",
    ].join("\n"),
  ).toString("base64");
const signedFor = (name, version) =>
  box(`timestamp:1700000000\tfile:${name}\tversion:${version}`);
const signatures = (version) =>
  Object.fromEntries(
    Object.values(UPDATER_TARGETS).map((asset) => [
      `${asset(version)}.sig`,
      `${signedFor(asset(version), version)}\n`,
    ]),
  );
const build = (files) =>
  updaterManifest({
    version: "0.5.4",
    repository: "satoshi-ltd/arca",
    tag: "v0.5.4",
    date: "",
    read: (name) => files[name],
  });

test("the manifest points every platform at its published asset and its signature", () => {
  const files = signatures("0.5.4");
  const manifest = updaterManifest({
    version: "0.5.4",
    repository: "satoshi-ltd/arca",
    tag: "v0.5.4",
    date: "2026-09-23T00:00:00.000Z",
    read: (name) => files[name],
  });
  assert.deepEqual(Object.keys(manifest.platforms), [
    "darwin-aarch64",
    "windows-x86_64",
    "linux-x86_64-deb",
    "linux-x86_64",
  ]);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://github.com/satoshi-ltd/arca/releases/download/v0.5.4/arca-0.5.4-macos-arm64.app.tar.gz",
  );
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    "https://github.com/satoshi-ltd/arca/releases/download/v0.5.4/arca-0.5.4-windows-x64.exe",
  );
  assert.equal(
    manifest.platforms["linux-x86_64"].url,
    "https://github.com/satoshi-ltd/arca/releases/download/v0.5.4/arca-0.5.4-linux-x64.AppImage",
  );
  assert.equal(
    manifest.platforms["linux-x86_64-deb"].url,
    "https://github.com/satoshi-ltd/arca/releases/download/v0.5.4/arca-0.5.4-linux-x64.deb",
    "a Debian install must be offered its own package, never the AppImage",
  );
  assert.equal(
    manifest.platforms["darwin-aarch64"].signature,
    signedFor("arca-0.5.4-macos-arm64.app.tar.gz", "0.5.4"),
    "signatures are trimmed, never padded with the trailing newline",
  );
  assert.equal(manifest.version, "0.5.4");
  assert.equal(manifest.notes, "Arca 0.5.4");
  assert.equal(manifest.pub_date, "2026-09-23T00:00:00.000Z");
});

test("a missing signature or a malformed version stops the manifest", () => {
  const files = signatures("0.5.4");
  delete files["arca-0.5.4-linux-x64.AppImage.sig"];
  assert.throws(
    () =>
      updaterManifest({
        version: "0.5.4",
        repository: "satoshi-ltd/arca",
        tag: "v0.5.4",
        date: "",
        read: (name) => files[name],
      }),
    /Missing updater signature: arca-0\.5\.4-linux-x64\.AppImage\.sig/,
  );
  const empty = signatures("0.5.4");
  empty["arca-0.5.4-windows-x64.exe.sig"] = "   \n";
  assert.throws(
    () =>
      updaterManifest({
        version: "0.5.4",
        repository: "satoshi-ltd/arca",
        tag: "v0.5.4",
        date: "",
        read: (name) => empty[name],
      }),
    /Missing updater signature: arca-0\.5\.4-windows-x64\.exe\.sig/,
  );
  for (const bad of ["", "0.5", "v0.5.4", "0.5.4-beta"])
    assert.throws(
      () =>
        updaterManifest({
          version: bad,
          repository: "satoshi-ltd/arca",
          tag: "x",
          date: "",
          read: () => "s",
        }),
      /x\.y\.z release version/,
    );
  assert.throws(
    () =>
      updaterManifest({
        version: "0.5.4",
        repository: "not a repo",
        tag: "v0.5.4",
        date: "",
        read: () => "s",
      }),
    /Repository is required/,
  );
});

test("a signature made for another version, or for none, stops the manifest", () => {
  const name = "arca-0.5.4-windows-x64.exe";
  for (const [comment, message] of [
    [`timestamp:1700000000\tfile:${name}`, /Updater signature carries no version, sign with a Tauri CLI that records it: arca-0\.5\.4-windows-x64\.exe\.sig/],
    [`timestamp:1700000000\tfile:app-version:0.5.4.exe`, /carries no version/],
    ["", /carries no version/],
    [`timestamp:1700000000\tfile:${name}\tversion:0.5.3`, /Updater signature is for version 0\.5\.3, not 0\.5\.4: arca-0\.5\.4-windows-x64\.exe\.sig/],
    [`timestamp:1700000000\tfile:${name}\tversion:0.5.40`, /is for version 0\.5\.40, not 0\.5\.4/],
    [`timestamp:1700000000\tfile:${name}\tversion:`, /is for version , not 0\.5\.4/],
  ])
    assert.throws(
      () => build({ ...signatures("0.5.4"), [`${name}.sig`]: box(comment) }),
      message,
      JSON.stringify(comment),
    );
  const older = Object.fromEntries(
    Object.entries(signatures("0.5.3")).map(([file, signature]) => [
      file.replace("0.5.3", "0.5.4"),
      signature,
    ]),
  );
  assert.throws(
    () => build(older),
    /Updater signature is for version 0\.5\.3, not 0\.5\.4: arca-0\.5\.4-macos-arm64\.app\.tar\.gz\.sig/,
    "an older release's signatures published under a newer number",
  );
});

test("a signature may spell its version with a leading v, as the updater itself allows", () => {
  const name = "arca-0.5.4-windows-x64.exe";
  assert.doesNotThrow(() =>
    build({ ...signatures("0.5.4"), [`${name}.sig`]: box(`timestamp:1700000000\tfile:${name}\tversion:v0.5.4`) }),
  );
  assert.throws(
    () => build({ ...signatures("0.5.4"), [`${name}.sig`]: box(`timestamp:1700000000\tfile:${name}\tversion:v0.5.3`) }),
    /is for version v0\.5\.3, not 0\.5\.4/,
  );
});

test("a malformed signature stops the manifest", () => {
  const name = "arca-0.5.4-linux-x64.deb";
  const comment = `timestamp:1700000000\tfile:${name}\tversion:0.5.4`;
  for (const [label, signature] of [
    ["plain text", `signature-for-${name}`],
    ["not a signature box", Buffer.from("version:0.5.4").toString("base64")],
    ["two lines", Buffer.from(`untrusted comment: x\ntrusted comment: ${comment}\n`).toString("base64")],
    ["an unlabelled comment", box(comment, { prefix: "comment: " })],
    ["a short signature", box(comment, { signature: 10 })],
    ["a short global signature", box(comment, { global: 10 })],
  ])
    assert.throws(
      () => build({ ...signatures("0.5.4"), [`${name}.sig`]: signature }),
      /Malformed updater signature: arca-0\.5\.4-linux-x64\.deb\.sig/,
      label,
    );
  const windowsLines = Buffer.from(
    Buffer.from(box(comment), "base64").toString("utf8").replace(/\n/g, "\r\n"),
  ).toString("base64");
  assert.doesNotThrow(() =>
    build({ ...signatures("0.5.4"), [`${name}.sig`]: windowsLines }),
  );
});

test("the desktop updater refuses a payload whose signature was not made for the announced version", () => {
  const config = JSON.parse(
    fs.readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.equal(config.plugins.updater.requireSignedVersion, true);
});

test("the Tauri CLI that signs releases is one that records the version in the signature", () => {
  const read = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
  const atLeast = (version) => {
    const [major, minor] = version.replace(/^\^/, "").split(".").map(Number);
    return major === 2 && minor >= 12;
  };
  assert.ok(atLeast(read("package.json").devDependencies["@tauri-apps/cli"]), "the declared range starts at 2.12");
  assert.ok(atLeast(read("package-lock.json").packages["node_modules/@tauri-apps/cli"].version), "the locked version is 2.12 or later");
});
