import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInstallers,
  bundleConfig,
  withRetry,
} from "../scripts/build-release.js";

test("each platform bundles its own installer targets and macOS carries the signing identity", () => {
  assert.deepEqual(bundleConfig("darwin", "-"), {
    targets: ["app", "dmg"],
    macOS: { signingIdentity: "-", hardenedRuntime: true },
  });
  assert.deepEqual(bundleConfig("darwin", "Developer ID Application: Arca"), {
    targets: ["app", "dmg"],
    macOS: {
      signingIdentity: "Developer ID Application: Arca",
      hardenedRuntime: true,
    },
  });
  assert.deepEqual(bundleConfig("win32", "-"), { targets: ["nsis"] });
  assert.deepEqual(bundleConfig("linux", "-"), {
    targets: ["appimage", "deb"],
  });
});

test("a failed macOS bundle is retried once and a second failure still fails", () => {
  const attempts = [];
  assert.equal(
    withRetry((attempt) => {
      attempts.push(attempt);
      if (attempt === 1) throw new Error("bundle_dmg.sh failed");
      return "bundled";
    }, 2),
    "bundled",
  );
  assert.deepEqual(attempts, [1, 2]);
  let calls = 0;
  assert.throws(
    () =>
      withRetry(() => {
        calls++;
        throw new Error("bundle_dmg.sh failed");
      }, 2),
    /bundle_dmg\.sh failed/,
  );
  assert.equal(calls, 2);
  let once = 0;
  assert.throws(
    () =>
      withRetry(() => {
        once++;
        throw new Error("nsis failed");
      }, 1),
    /nsis failed/,
  );
  assert.equal(once, 1, "platforms without the DMG flake never retry");
});

test("macOS retries packaging without recompiling the application", () => {
  const commands = [];
  buildInstallers("darwin", "-", (command, args) => {
    commands.push(args);
    if (commands.length === 2) throw new Error("bundle_dmg.sh failed");
  });
  assert.deepEqual(
    commands.map((args) => args[1]),
    ["build", "bundle", "bundle"],
  );
  assert.ok(commands[0].includes("--no-bundle"));
  for (const args of commands) {
    assert.ok(args.includes("--verbose"));
    assert.deepEqual(JSON.parse(args.at(-1)), {
      bundle: bundleConfig("darwin", "-"),
    });
  }
});

test("macOS compilation failures stop before packaging and are not retried", () => {
  let calls = 0;
  assert.throws(
    () =>
      buildInstallers("darwin", "-", () => {
        calls++;
        throw new Error("cargo failed");
      }),
    /cargo failed/,
  );
  assert.equal(calls, 1);
});

test("persistent macOS packaging failures still fail the release", () => {
  const commands = [];
  assert.throws(
    () =>
      buildInstallers("darwin", "-", (command, args) => {
        commands.push(args[1]);
        if (args[1] === "bundle") throw new Error("installer failed");
      }),
    /installer failed/,
  );
  assert.deepEqual(commands, ["build", "bundle", "bundle"]);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} retains a single build and bundle command`, () => {
    let calls = 0;
    assert.throws(
      () =>
        buildInstallers(platform, "-", (command, args) => {
          calls++;
          assert.equal(args[1], "build");
          assert.ok(!args.includes("--no-bundle"));
          assert.deepEqual(JSON.parse(args.at(-1)), {
            bundle: bundleConfig(platform, "-"),
          });
          throw new Error("build failed");
        }),
      /build failed/,
    );
    assert.equal(calls, 1);
  });
}
