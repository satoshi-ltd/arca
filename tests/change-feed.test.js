import test from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed } from "../packages/daemon/change-feed.js";

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
