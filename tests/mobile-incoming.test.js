import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  IncomingSession,
  clearIncoming,
  copyPicked,
  resolveShared,
} from "../apps/mobile/src/incoming-files.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arca-incoming-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const temporary = path.join(root, "cache");
  const source = path.join(root, "source.fit"),
    saved = path.join(root, "saved.fit");
  await fs.writeFile(source, "workout");
  const runtime = {
    space: async () => {},
    files: {
      incoming: (key) => path.join(temporary, key),
      parent: path.dirname,
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      stat: (p) => fs.stat(fileURLToPath(p)),
      copy: (a, b) => fs.copyFile(fileURLToPath(a), b),
      remove: (p) => fs.rm(p, { force: true }),
      clearIncoming: async () => {
        await fs.rm(temporary, { recursive: true, force: true });
      },
    },
  };
  const payload = {
    shareType: "file",
    originalName: "source.fit",
    contentUri: pathToFileURL(source).href,
  };
  return {
    root,
    source,
    saved,
    temporary,
    runtime,
    payload,
    session: new IncomingSession(runtime),
  };
}
async function missing(p) {
  await assert.rejects(fs.stat(p), { code: "ENOENT" });
}

test("cancel discards temporary copies, keeps originals and cannot resume in a new session", async (t) => {
  const f = await fixture(t);
  const [item] = await f.session.receive([f.payload], "first");
  await f.session.cancel();
  assert.deepEqual(f.session.items, []);
  assert.deepEqual(new IncomingSession(f.runtime).items, []);
  await missing(item.uri);
  assert.equal(await fs.readFile(f.source, "utf8"), "workout");
});

test("cancel during native resolution does not stage or reopen the share", async (t) => {
  const f = await fixture(t);
  let resolve, started;
  const ready = new Promise((r) => (started = r));
  const receiving = f.session.receive(() => {
    started();
    return new Promise((r) => (resolve = r));
  }, "late");
  await ready;
  await f.session.cancel();
  resolve([f.payload]);
  assert.equal(await receiving, null);
  await missing(f.temporary);
});

test("cancel during copying cleans the late copy instead of restoring pending items", async (t) => {
  const f = await fixture(t);
  let finish, started;
  const ready = new Promise((r) => (started = r)),
    copying = f.runtime.files.copy;
  f.runtime.files.copy = async (...args) => {
    await copying(...args);
    started();
    await new Promise((r) => (finish = r));
  };
  const receiving = f.session.receive([f.payload], "late-copy");
  await ready;
  await f.session.cancel();
  finish();
  assert.equal(await receiving, null);
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test("a new share replaces the cancelled batch instead of accumulating an inbox", async (t) => {
  const f = await fixture(t);
  const [first] = await f.session.receive([f.payload], "first");
  const second = await f.session.receive([f.payload], "second");
  await missing(first.uri);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, "second-0");
});

test("cancel after a partial save preserves the saved destination and discards the remainder", async (t) => {
  const f = await fixture(t);
  const secondSource = path.join(f.root, "second.fit");
  await fs.writeFile(secondSource, "second");
  const [first, second] = await f.session.receive(
    [f.payload, { ...f.payload, contentUri: pathToFileURL(secondSource).href }],
    "batch",
  );
  await fs.copyFile(first.uri, f.saved);
  await f.session.saved(first);
  await f.session.cancel();
  await missing(first.uri);
  await missing(second.uri);
  assert.equal(await fs.readFile(f.saved, "utf8"), "workout");
  assert.equal(await fs.readFile(secondSource, "utf8"), "second");
});

test("startup removes abandoned private copies without touching saved files", async (t) => {
  const f = await fixture(t);
  await f.session.receive([f.payload], "abandoned");
  await fs.writeFile(f.saved, "saved");
  await clearIncoming(f.runtime);
  await missing(f.temporary);
  assert.equal(await fs.readFile(f.source, "utf8"), "workout");
  assert.equal(await fs.readFile(f.saved, "utf8"), "saved");
});

test("unsupported sender names can be corrected without losing the staged file", async (t) => {
  const { incomingDestination, incomingFilenameError } =
    await import("../apps/mobile/src/incoming-files.js");
  const f = await fixture(t);
  const [item] = await f.session.receive(
    [{ ...f.payload, originalName: "Run 2026-09-09 07:35.fit" }],
    "rename",
  );
  assert.equal(item.renameRequired, true);
  assert.equal(await fs.readFile(item.uri, "utf8"), "workout");
  assert.throws(() => incomingDestination("", item.name), /Rename/);
  assert.equal(incomingFilenameError("Run 2026-09-09 07-35.fit"), "");
  assert.equal(
    incomingDestination("", "Run 2026-09-09 07-35.fit"),
    "Run 2026-09-09 07-35.fit",
  );
  assert.throws(() => incomingDestination("", "../escape.fit"), /not a path/);
  await f.session.cancel();
  await missing(item.uri);
  assert.equal(await fs.readFile(f.source, "utf8"), "workout");
});

test("Android shares are copied to generated inbox names and never use the sender's file name", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const receive = async (uri, destination) => {
    calls.push({ uri, destination });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "workout");
    return { name: "../../files/evil.fit", size: 7 };
  };
  const raw = [{ shareType: "file", value: "content://other.app/files/1" }];
  const resolved = await resolveShared(f.runtime, receive, raw, "share-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].destination, path.join(f.temporary, "share-1-0"));
  assert.equal(calls[0].destination.includes("evil"), false);
  assert.equal(resolved[0].staged, true);
  await assert.rejects(f.session.receive(resolved, "share-1"), /contains a path/);
  await missing(calls[0].destination);
});

test("staged shares are verified and kept without a second copy, and a failure removes every staged file", async (t) => {
  const f = await fixture(t);
  let copies = 0;
  f.runtime.files.copy = async () => {
    copies++;
  };
  f.runtime.files.stat = (p) => fs.stat(p.startsWith("file:") ? fileURLToPath(p) : p);
  const receive = async (uri, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "workout");
    return { name: "run.fit", size: 7 };
  };
  const raw = [
    { shareType: "file", value: "content://other.app/files/1" },
    { shareType: "file", value: "content://other.app/files/2" },
  ];
  const resolved = await resolveShared(f.runtime, receive, raw, "share-2");
  const items = await f.session.receive(resolved, "share-2");
  assert.equal(copies, 0);
  assert.deepEqual(items.map((item) => item.name), ["run.fit", "run.fit"]);
  assert.equal(await fs.readFile(items[0].uri, "utf8"), "workout");
  await f.session.cancel();
  await missing(items[0].uri);

  let calls = 0;
  const failing = async (uri, destination) => {
    if (calls++ === 1) throw new Error("The shared file is incomplete.");
    return receive(uri, destination);
  };
  await assert.rejects(resolveShared(f.runtime, failing, raw, "share-3"), /incomplete/);
  await missing(path.join(f.temporary, "share-3-0"));

  await assert.rejects(
    resolveShared(f.runtime, receive, [{ shareType: "text", value: "hello" }], "share-4"),
    /rather than a link or text/,
  );
  await assert.rejects(resolveShared(f.runtime, receive, [], "share-5"), /between 1 and 20/);
});

test("Android Import files copies each pick natively into the inbox, off the picker's main-thread copy, and removes the copies on failure", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const receive = async (uri, destination) => {
    calls.push({ uri, destination });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "pick");
    return { name: "provider-name.bin", size: 4 };
  };
  const assets = [
    { uri: "content://docs/1", name: "Report.pdf" },
    { uri: "content://docs/2" },
  ];
  const copies = await copyPicked(f.runtime, receive, assets, "import-1");
  assert.deepEqual(copies.map((copy) => copy.name), ["Report.pdf", "provider-name.bin"], "the picker's name wins, the provider's fills a gap");
  assert.deepEqual(calls.map((call) => call.destination), [path.join(f.temporary, "import-1-0"), path.join(f.temporary, "import-1-1")]);
  assert.equal(await fs.readFile(copies[0].uri, "utf8"), "pick");
  let attempts = 0;
  const failing = async (uri, destination) => {
    if (++attempts === 2) throw new Error("provider went away");
    return receive(uri, destination);
  };
  await assert.rejects(copyPicked(f.runtime, failing, assets, "import-2"), /provider went away/);
  await missing(path.join(f.temporary, "import-2-0"));
  await missing(path.join(f.temporary, "import-2-1"));
  const read = (file) => fs.readFile(new URL(`../apps/mobile/${file}`, import.meta.url), "utf8");
  const app = await read("src/App.jsx");
  assert.match(app, /copyToCacheDirectory: Platform\.OS !== "android"/, "the picker no longer copies on Android");
  const imported = app.slice(app.indexOf("async function imported("), app.indexOf("function choose("));
  assert.match(imported, /kind !== "photos" && Platform\.OS === "android"[\s\S]*copyPicked\(\s+replica,\s+\(uri, destination\) => native\.receiveShared\(uri, destination\),\s+result\.assets,/);
  assert.match(imported, /copied\s+\? replica\.files\.remove\(asset\.uri\)\s+: replica\.files\.discardPicked\(asset\.uri\)/, "the inbox copies are removed after the import, iOS keeps its cleanup");
});

test("the Android share path never lets the library resolve files into the cache", async () => {
  const read = (file) => fs.readFile(new URL(`../apps/mobile/${file}`, import.meta.url), "utf8");
  const screen = await read("src/IncomingShare.jsx");
  const android = screen.slice(screen.indexOf('Platform.OS === "android"'));
  assert.match(android.slice(0, 260), /resolveShared\(/);
  assert.ok(android.indexOf("resolveShared(") < android.indexOf("Sharing.getResolvedSharedPayloadsAsync"));
  const kotlin = await read("modules/arca-network/android/src/main/java/expo/modules/arcanetwork/SharedFiles.kt");
  assert.match(kotlin, /check\(uri\.scheme == "content"\)/);
  assert.match(kotlin, /uri\.host\?\.lowercase\(\)/);
  assert.match(kotlin, /resolveContentProvider\(authority, 0\)\?\.packageName != context\.packageName/);
  assert.doesNotMatch(kotlin, /uri\.authority/);
  assert.match(kotlin, /check\(target\.path\.startsWith\(inbox\.path \+ "\/"\)\)/);
  assert.doesNotMatch(kotlin, /File\(context\.cacheDir, (name|fileName|displayName)/);
  assert.match(await read("modules/arca-network/android/src/main/java/expo/modules/arcanetwork/ArcaNetworkModule.kt"), /AsyncFunction\("receiveShared"\)/);
});

test("cancelling while the share is still being resolved removes the staged files", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const receive = async (uri, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "workout");
    await gate;
    return { name: "run.fit", size: 7 };
  };
  const raw = [{ shareType: "file", value: "content://other.app/files/1" }];
  const receiving = f.session.receive(
    () => resolveShared(f.runtime, receive, raw, "late-1"),
    "late-1",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.session.cancel();
  release();
  assert.equal(await receiving, null);
  await missing(path.join(f.temporary, "late-1-0"));
});

test("the share sheet offers recent destinations above the folder list and records every save", async () => {
  const screen = await fs.readFile(new URL("../apps/mobile/src/IncomingShare.jsx", import.meta.url), "utf8");
  const list = screen.slice(screen.indexOf(") : !volume ? ("), screen.indexOf('label="Shared folders"'));
  assert.ok(list.indexOf("RECENT DESTINATIONS") > 0 && list.indexOf("RECENT DESTINATIONS") < list.indexOf("SELECTED FOLDERS"));
  assert.match(list, /\{!!recent\.length && \(/, "no section without history");
  assert.match(list, /icon="history"\s+name=\{destinationLabel\(entry\)\}\s+description=\{destinationUsage\(entry\)\}/);
  assert.match(list, /setVolume\(entry\.folder\);\s+setDirectory\(entry\.directory\);/, "one tap lands on the destination");
  const save = screen.slice(screen.indexOf("async function save()"), screen.indexOf("async function discard()"));
  const remembered = save.search(/await saveDestination\(\s*r\.store,\s*r\.scope,\s*destinations,\s*volume\.id,\s*directory,?\s*\)\.catch\(\(\) => \{\}\);/);
  assert.ok(remembered > save.indexOf("r.importing = false;"), "the destination is remembered only after every file is saved, and never blocks the sheet");
  assert.ok(remembered < save.indexOf("setOpen(false);"));
  const load = screen.slice(screen.indexOf("if (!open) return;"), screen.indexOf("}, [open, connection?.hubId, locals]);"));
  assert.match(load, /r\.scope && r\.scope === connection\?\.hubId\s+\? await loadDestinations\(r\.store, r\.scope, choices\)/);
  assert.match(screen, /setDirectory\(""\);\s+setRecent\(\[\]\);\s+\}, \[connection\?\.hubId\]\);/, "another hub starts without the old list");
});
