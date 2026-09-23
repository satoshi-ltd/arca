import test from "node:test";
import assert from "node:assert/strict";
import {
  UPDATER_TARGETS,
  updaterManifest,
} from "../scripts/updater-manifest.js";

const signatures = (version) =>
  Object.fromEntries(
    Object.values(UPDATER_TARGETS).map((asset) => [
      `${asset(version)}.sig`,
      `signature-for-${asset(version)}\n`,
    ]),
  );

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
    "signature-for-arca-0.5.4-macos-arm64.app.tar.gz",
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
