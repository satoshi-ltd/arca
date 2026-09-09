import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  IncomingSession,
  clearIncoming,
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
