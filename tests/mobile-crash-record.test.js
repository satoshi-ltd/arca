import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  crashNotice,
  createCrashRecord,
  installCrashHandler,
} from "../apps/mobile/src/crash-record.js";

function memory(initial = null) {
  const store = { text: initial, writes: 0, removes: 0 };
  return {
    store,
    read: () => store.text,
    write: (text) => {
      store.writes++;
      store.text = text;
    },
    remove: () => {
      store.removes++;
      store.text = null;
    },
  };
}

test("a fatal error is saved synchronously and read back once", () => {
  const disk = memory();
  const crash = createCrashRecord({ ...disk, now: () => Date.UTC(2026, 8, 30, 21, 14) });
  assert.equal(crash.record(new TypeError("undefined is not an object"), true), true);
  assert.equal(disk.store.writes, 1);
  const taken = crash.take();
  assert.deepEqual(taken, { name: "TypeError", message: "undefined is not an object", at: Date.UTC(2026, 8, 30, 21, 14) });
  assert.equal(crash.take(), null, "it is shown once");
  assert.equal(disk.store.removes, 1);
});

test("an error that did not close the app is not recorded, and recording never throws", () => {
  const disk = memory();
  const crash = createCrashRecord(disk);
  assert.equal(crash.record(new Error("handled elsewhere"), false), false);
  assert.equal(disk.store.writes, 0);
  const broken = createCrashRecord({ read: () => { throw new Error("disk"); }, write: () => { throw new Error("disk full"); }, remove: () => { throw new Error("disk"); } });
  assert.equal(broken.record(new Error("x"), true), false);
  assert.equal(broken.take(), null);
});

test("a corrupt or foreign record is discarded without a notice, and long or odd errors are bounded", () => {
  for (const text of ["{", "null", "[]", '{"message":5,"at":"yesterday"}', '{"name":"Error","message":"x"}']) {
    const disk = memory(text);
    assert.equal(createCrashRecord(disk).take(), null, text);
    assert.equal(disk.store.removes, 1, "and removed");
  }
  const disk = memory();
  const crash = createCrashRecord(disk);
  crash.record({ message: "m".repeat(5000) }, true);
  assert.equal(crash.take().message.length, 600);
  const fixed = createCrashRecord({ ...disk, now: () => 7 });
  fixed.record("a string was thrown", true);
  assert.deepEqual(fixed.take(), { name: "Error", message: "a string was thrown", at: 7 });
});

test("the global handler records fatal errors and always calls the previous handler", () => {
  const calls = [];
  let handler = (error, fatal) => calls.push(["previous", error.message, fatal]);
  const utils = { getGlobalHandler: () => handler, setGlobalHandler: (next) => (handler = next) };
  const disk = memory();
  installCrashHandler(utils, createCrashRecord(disk));
  handler(new Error("boom"), true);
  assert.deepEqual(calls, [["previous", "boom", true]]);
  assert.ok(disk.store.text.includes("boom"));
  handler(new Error("soft"), false);
  assert.deepEqual(calls.at(-1), ["previous", "soft", false]);
  assert.equal(disk.store.writes, 1, "a non-fatal error is not recorded");
  const failing = { record: () => { throw new Error("recorder bug"); } };
  const second = { getGlobalHandler: () => (error) => calls.push(["kept", error.message]), setGlobalHandler: (next) => (second.handler = next) };
  installCrashHandler(second, failing);
  second.handler(new Error("late"), true);
  assert.deepEqual(calls.at(-1), ["kept", "late"], "a recorder that fails never hides the error from the previous handler");
});

test("the notice is the error notice drawn on the board, with the message and the time under Details", () => {
  const notice = crashNotice({ name: "TypeError", message: "undefined is not an object", at: new Date(2026, 8, 30, 21, 14).getTime() });
  assert.equal(notice.kind, "error");
  assert.equal(notice.id, "crash");
  assert.equal(notice.icon, "circle-alert");
  assert.equal(notice.title, "Arca closed unexpectedly");
  assert.equal(notice.body, "Your files are safe. The error was saved on this phone.");
  assert.equal(notice.details, "TypeError: undefined is not an object · Sep 30, 21:14");
  assert.equal("action" in notice, false, "Dismiss, Details and Copy are the whole interface");
});

test("the app installs the handler at startup and shows the record once on launch", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/mobile/${file}`, import.meta.url), "utf8").replace(/\s+/g, " ");
  const entry = read("index.js");
  assert.ok(entry.includes('import "./src/crash"'), "the handler is installed before the app loads");
  const crash = read("src/crash.js");
  assert.ok(crash.includes("installCrashHandler(globalThis.ErrorUtils, crashRecord)"));
  assert.ok(crash.includes("export const crashRecord = createCrashRecord(crashFile);"));
  const file = read("src/crash-file.js");
  assert.ok(file.includes("read: () => { const file = store(); return file.exists ? file.textSync() : null; }"));
  assert.ok(file.includes("write: (text) => store().write(text)"));
  const app = read("src/App.jsx");
  assert.ok(app.includes("const crash = crashRecord.take(); if (crash) notices.push(crashNotice(crash));"));
  assert.ok(app.indexOf("notices.subscribe(") < app.indexOf("crashRecord.take()"), "the notice is pushed after the stack subscribes, so it is rendered");
});

test("the first fatal error of a run is the one that is kept, until it is read", () => {
  const disk = memory();
  const crash = createCrashRecord(disk);
  assert.equal(crash.record(new Error("root cause"), true), true);
  assert.equal(crash.record(new Error("follow-up"), true), false, "a cascading error never replaces the root cause");
  assert.ok(disk.store.text.includes("root cause"));
  assert.equal(crash.take().message, "root cause");
  assert.equal(crash.record(new Error("next run"), true), true, "and a later run records again");
});

test("a notice pushed after the stack subscribes reaches the rendered list", async () => {
  const { createNoticeStore } = await import("../apps/desktop/src/notice-contract.js");
  const notices = createNoticeStore();
  const rendered = [];
  const off = notices.subscribe(() => rendered.splice(0, rendered.length, ...notices.snapshot()));
  notices.push(crashNotice({ name: "Error", message: "boom", at: 0 }));
  assert.deepEqual(rendered.map((item) => item.id), ["crash"]);
  assert.equal(rendered[0].details.startsWith("Error: boom"), true);
  notices.remove("crash");
  assert.deepEqual(rendered, []);
  off();
  notices.dispose();
});
