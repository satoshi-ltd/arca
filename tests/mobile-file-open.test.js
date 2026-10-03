import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../apps/mobile/src/App.jsx", import.meta.url),
  "utf8",
);
const actions = source.slice(
  source.indexOf("  async function currentFileURI()"),
  source.indexOf("  async function imported("),
);
function harness({ exists = true, sharing = true } = {}) {
  const calls = [];
  const uri = "file:///documents/caf%C3%A9.pdf";
  const context = {
    engine: {
      current: {
        scope: "hub",
        files: {
          work: (scope, volume, path) => {
            assert.equal(scope, "hub");
            assert.equal(volume, "docs");
            assert.equal(path, "café.pdf");
            return uri;
          },
          exists: async () => exists,
        },
      },
    },
    sheet: { volume: "docs", path: "café.pdf" },
    native: { openFile: async (file) => calls.push(["open", file]) },
    Sharing: {
      isAvailableAsync: async () => sharing,
      shareAsync: async (file) => calls.push(["share", file]),
    },
  };
  vm.createContext(context);
  vm.runInContext(actions, context);
  return { context, calls, uri };
}
test("mobile Open and Share use the selected local file and distinct system actions", async () => {
  const { context, calls, uri } = harness();
  await context.openCurrentFile();
  await context.shareCurrentFile();
  assert.deepEqual(calls, [
    ["open", uri],
    ["share", uri],
  ]);
});
test("mobile never opens or shares a missing local file", async () => {
  const { context, calls } = harness({ exists: false });
  await assert.rejects(context.openCurrentFile(), /not available locally/);
  await assert.rejects(context.shareCurrentFile(), /not available locally/);
  assert.deepEqual(calls, []);
});
test("mobile Open does not depend on sharing availability and reports native failures", async () => {
  const { context } = harness({ sharing: false });
  await context.openCurrentFile();
  await assert.rejects(context.shareCurrentFile(), /Sharing is unavailable/);
  context.native.openFile = async () => {
    throw new Error("No installed app can open this file.");
  };
  await assert.rejects(context.openCurrentFile(), /No installed app/);
});

test("older installed clients explain that Open requires an app update", async () => {
  const { context, calls, uri } = harness();
  delete context.native.openFile;
  await assert.rejects(
    context.openCurrentFile(),
    /Install the updated Arca app/,
  );
  await context.shareCurrentFile();
  assert.deepEqual(calls, [["share", uri]]);
});

test("APK authorization explains the next step and opens settings only on request", async () => {
  const { context, calls } = harness();
  let prompt;
  context.native.openFile = async () => "install-permission";
  context.native.openInstallSettings = async () => calls.push(["settings"]);
  context.run = (action) => action();
  context.Alert = {
    alert: (...args) => {
      prompt = args;
    },
  };
  await context.openCurrentFile();
  assert.equal(prompt[0], "Allow APK installation");
  assert.match(prompt[1], /tap Open again/);
  assert.equal(prompt[2][0].style, "cancel");
  assert.equal(prompt[2][0].onPress, undefined);
  assert.deepEqual(calls, []);
  await prompt[2][1].onPress();
  assert.deepEqual(calls, [["settings"]]);
});

test("Android opens a file with its type, then as plain text for text files, then as a generic file", () => {
  const kotlin = fs.readFileSync(
    new URL("../apps/mobile/modules/arca-network/android/src/main/java/expo/modules/arcanetwork/ArcaNetworkModule.kt", import.meta.url),
    "utf8",
  );
  const open = kotlin.slice(kotlin.indexOf('AsyncFunction("openFile")'), kotlin.indexOf('AsyncFunction("openInstallSettings")'));
  assert.match(open, /"md", "markdown", "json", "jsonl", "yaml", "yml"/, "markdown and structured text count as text");
  assert.match(open, /listOfNotNull\(mime\.takeIf \{ it != "application\/octet-stream" \}, if \(textual\) "text\/plain" else null, "application\/octet-stream"\)/);
  assert.match(open, /if \(apk\) listOf\(mime\)/, "an APK never falls back to another type");
  assert.match(open, /for \(type in types\) \{[\s\S]*startActivity\(intent\); opened = true; break[\s\S]*ActivityNotFoundException\) \{\}/, "each type is tried until one app answers");
  assert.match(open, /if \(!opened\) error\("No installed app can open this file\. Try Share from the file menu\."\)/);
  assert.match(open, /SecurityException\) \{ error\("Android blocked opening this file\./, "a blocked file stops at once");
});
