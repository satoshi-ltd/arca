import test from "node:test";
import assert from "node:assert/strict";
import {
  TransferSession,
  shouldStopSync,
} from "../apps/mobile/src/transfer-session.js";

test("photo transfer lease starts once, stays active when hidden and releases on completion", async () => {
  let visible = true,
    starts = 0,
    stops = 0;
  let release;
  const session = new TransferSession({
    visible: () => visible,
    start: () => {
      starts++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    stop: async () => {
      stops++;
    },
    update: async () => {},
  });
  const a = session.begin(),
    b = session.begin();
  assert.equal(starts, 1);
  release();
  assert.equal(await a, true);
  assert.equal(await b, true);
  visible = false;
  assert.equal(await session.begin(), true);
  await session.end();
  await session.end();
  assert.equal(stops, 1);
  assert.equal(session.active, false);
  assert.equal(await session.begin(), false);
});

test("failed native starts do not claim background execution and can retry", async () => {
  let fails = true;
  const session = new TransferSession({
    visible: () => true,
    start: async () => {
      if (fails) throw new Error("Restricted");
    },
    stop: async () => {},
    update: async () => {},
  });
  await assert.rejects(session.begin(), /Restricted/);
  assert.equal(session.active, false);
  fails = false;
  assert.equal(await session.begin(), true);
  await session.end();
});

test("ending during native startup releases the acquired service", async () => {
  let release,
    stopped = false;
  const session = new TransferSession({
    visible: () => true,
    start: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    stop: async () => {
      stopped = true;
    },
    update: async () => {},
  });
  const start = session.begin();
  const end = session.end();
  release();
  await Promise.all([start, end]);
  assert.equal(stopped, true);
  assert.equal(session.active, false);
});

test("sync stops only when the app is backgrounded without a transfer lease", () => {
  assert.equal(shouldStopSync("inactive", false), false);
  assert.equal(shouldStopSync("active", false), false);
  assert.equal(shouldStopSync("background", false), true);
  assert.equal(shouldStopSync("background", true), false);
});
