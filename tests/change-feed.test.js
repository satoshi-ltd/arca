import test from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed } from "../packages/daemon/change-feed.js";
import { abortable, abortRequest } from "../apps/mobile/src/request-control.js";

test("change feed wakes shared waiters, handles disconnect and closes cleanly", async () => {
  let revision = "one";
  const feed = new ChangeFeed(() => revision);
  try {
    assert.equal(await feed.wait(null, new AbortController().signal), "one");
    const controller = new AbortController();
    const disconnected = feed.wait("one", controller.signal);
    const first = feed.wait("one", new AbortController().signal);
    const second = feed.wait("one", new AbortController().signal);
    controller.abort();
    assert.equal(await disconnected, "one");
    revision = "two";
    assert.deepEqual(await Promise.all([first, second]), ["two", "two"]);
    assert.equal(feed.waiters.size, 0);
    assert.equal(feed.timer, null);
    const closing = feed.wait("two", new AbortController().signal);
    feed.close();
    assert.equal(await closing, null);
  } finally {
    feed.close();
  }
});

test("cancellation retains its reason with a React Native style signal lacking reason", async () => {
  const signal = new EventTarget();
  signal.aborted = false;
  const controller = {
    signal,
    abort() {
      signal.aborted = true;
      signal.dispatchEvent(new Event("abort"));
    },
  };
  const pending = abortable(() => new Promise(() => {}), signal);
  const error = Object.assign(new Error("Sync paused"), {
    code: "SYNC_INTERRUPTED",
  });
  abortRequest(controller, error);
  await assert.rejects(pending, (e) => e === error);
});

test("foreground resume waits for the cancelled turn and immediately starts fresh work", async () => {
  const { Replica } = await import("../apps/mobile/src/replica.js");
  const replica = new Replica({ store: {}, files: {}, client: {} });
  let release, entered, turns = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  replica.cycle = async () => {
    replica.stopped = false;
    if (++turns === 1) { entered(); await gate; }
  };
  const first = replica.sync();
  await started;
  replica.stop();
  const resumed = replica.sync(false, { scheduled: true });
  release();
  await Promise.all([first, resumed]);
  assert.equal(turns, 2);
  assert.equal(replica.stopped, false);
});
