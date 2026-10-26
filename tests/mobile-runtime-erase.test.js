import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { Replica } from "../apps/mobile/src/replica.js";
import { ReplicaStore } from "../apps/mobile/src/replica-store.js";
import { TransferSession } from "../apps/mobile/src/transfer-session.js";

const source = fs
  .readFileSync(
    new URL("../apps/mobile/src/runtime.js", import.meta.url),
    "utf8",
  )
  .replace(/^import .*;\n/gm, "")
  .replace(/^export /gm, "");

async function fixture(t, { platform = "android" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-runtime-erase-"));
  const local = path.join(root, "arca");
  const outside = path.join(root, "Photos-original.txt");
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, "unsynced.txt"), "private working copy");
  fs.writeFileSync(outside, "keep original");
  const db = new DatabaseSync(path.join(root, "replica.sqlite"));
  const adapter = {
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...values) => db.prepare(sql).run(...values),
    getFirstAsync: async (sql, ...values) => db.prepare(sql).get(...values),
    getAllAsync: async (sql, ...values) => db.prepare(sql).all(...values),
  };
  const state = {
    failure: null,
    registered: true,
    credential: "local-secret",
    calls: [],
    timers: new Map(),
  };
  const attempt = async (name, work = () => {}) => {
    state.calls.push(name);
    if (state.failure === name) throw new Error(`${name} unavailable`);
    return work();
  };
  const client = {
    load: async () => {},
    state: () => ({ connection: state.connection || null, catalog: null }),
    destroy: async () => {
      state.credential = null;
      state.connection = null;
    },
  };
  const files = {
    destroy: async () => {
      await state.destroying;
      fs.rmSync(local, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  const create = (lastResponse = Promise.resolve(null)) => {
    let timer = 0;
    const context = vm.createContext({
      Replica,
      ReplicaStore,
      TransferSession,
      client,
      files,
      mediaLibrary: {},
      player: { reload: async () => {} },
      Application: { nativeApplicationVersion: "0.7.80" },
      config: { expo: { version: "0.7.80" } },
      clearIncoming: async () => {},
      errorNotice: (message) => ({ message }),
      SQLite: { openDatabaseAsync: async () => adapter },
      Platform: { OS: platform },
      AppState: { currentState: "background" },
      AppRegistry: { registerHeadlessTask() {} },
      native: {
        addListener() {},
        transferProgress: async () => {},
        startTransfer: async () => {},
        stopTransfer: async () => {},
      },
      TaskManager: {
        defineTask() {},
        isTaskRegisteredAsync: async () =>
          attempt("query", () => state.registered),
      },
      BackgroundTask: {
        BackgroundTaskResult: { Success: 1, Failed: 2 },
        unregisterTaskAsync: async () =>
          attempt("background", () => {
            state.registered = false;
          }),
      },
      Notifications: {
        addNotificationResponseReceivedListener(listener) {
          state.responseListener = listener;
        },
        setNotificationHandler() {},
        getLastNotificationResponseAsync: () => lastResponse,
        setNotificationCategoryAsync: async () => {},
        cancelAllScheduledNotificationsAsync: async () => attempt("scheduled"),
        dismissAllNotificationsAsync: async () => {
          await state.delivery;
          return attempt("delivered");
        },
        clearLastNotificationResponseAsync: async () => attempt("response"),
      },
      setTimeout: (callback) => {
        state.timers.set(++timer, callback);
        return timer;
      },
      clearTimeout: (id) => state.timers.delete(id),
    });
    return vm.runInContext(
      `${source}\n({runtime, destroyReplica, publishConditions, receivedResponse, subscribeNotificationResponse, noticeState, response: () => pendingResponse})`,
      context,
    );
  };
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const api = create();
  const replica = await api.runtime();
  await replica.store.set("background", true);
  await replica.store.set("notifications", true);
  await api.publishConditions(replica.store, [
    { id: "offline", title: "Old hub", offline: true },
  ]);
  assert.equal(state.timers.size, 1);
  return { root, local, outside, state, create, api, replica };
}

for (const failure of [
  "query",
  "background",
  "scheduled",
  "delivered",
  "response",
]) {
  for (const restart of [false, true]) {
    test(`mobile erase retries ${failure} cleanup ${restart ? "on launch" : "in the same runtime"}`, async (t) => {
      const f = await fixture(t);
      f.state.failure = failure;
      await assert.rejects(f.api.destroyReplica());
      assert.equal(
        fs.existsSync(f.local),
        false,
        "OS cleanup failures never prevent local erasure",
      );
      assert.equal(f.state.credential, null);
      assert.equal(
        await f.replica.store.get("destroyPending"),
        true,
        "cleanup stays durable and retryable",
      );
      assert.equal(await f.replica.store.get("background"), false);
      assert.equal(
        f.state.timers.size,
        0,
        "old notice timers cannot restart synchronization",
      );
      for (const name of ["scheduled", "delivered", "response"])
        assert.ok(
          f.state.calls.includes(name),
          `${name} cleanup is attempted despite other failures`,
        );
      f.state.failure = null;
      const replica = restart ? await f.create().runtime() : f.replica;
      if (!restart) await f.api.destroyReplica();
      assert.equal(await replica.store.get("destroyPending"), null);
      assert.equal(f.state.registered, false);
      assert.equal(fs.readFileSync(f.outside, "utf8"), "keep original");
    });
  }
}

test("mobile erase forgets a notification response already waiting for its UI", async (t) => {
  const f = await fixture(t);
  f.api.receivedResponse({
    notification: {
      request: {
        content: {
          data: {
            notice: { id: "private", action: "folder", volume: "old-folder" },
          },
        },
      },
    },
  });
  assert.ok(f.api.response());
  await f.api.destroyReplica();
  assert.equal(f.api.response(), null);
  assert.equal(f.api.noticeState.size, 0);
});

test("a notification response loaded before erase cannot return after completion", async (t) => {
  const f = await fixture(t);
  let resolveResponse;
  const api = f.create(
    new Promise((resolve) => {
      resolveResponse = resolve;
    }),
  );
  await api.runtime();
  await api.destroyReplica();
  resolveResponse({
    notification: {
      request: {
        content: {
          data: {
            notice: { id: "private", action: "folder", volume: "old-folder" },
          },
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.response(), null);
});

test("late OS responses cannot navigate during or after erase until a new pairing", async (t) => {
  const f = await fixture(t);
  let release;
  f.state.delivery = new Promise((resolve) => {
    release = resolve;
  });
  const delivered = [];
  f.api.subscribeNotificationResponse((item) => delivered.push(item));
  const erasing = f.api.destroyReplica();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    f.state.calls.includes("scheduled"),
    "system cleanup is waiting for delivery dismissal",
  );
  const response = (volume) => ({
    notification: {
      request: {
        content: { data: { notice: { id: volume, action: "folder", volume } } },
      },
    },
  });
  f.state.responseListener(response("old-folder"));
  release();
  await erasing;
  f.state.responseListener(response("old-folder"));
  assert.equal(delivered.length, 0);
  assert.equal(f.api.response(), null);
  f.state.connection = { linked: true, hubId: "new-hub" };
  f.state.responseListener(response("new-folder"));
  assert.equal(
    delivered.length,
    1,
    "new paired notifications still navigate normally",
  );
  assert.equal(delivered[0].volume, "new-folder");
});

test("a background-setting failure cannot suppress the remaining erase cleanup", async (t) => {
  const f = await fixture(t);
  const set = f.replica.store.set.bind(f.replica.store);
  f.replica.store.set = async (key, value) => {
    if (key === "background" && value === false)
      throw new Error("setting write failed");
    return set(key, value);
  };
  await assert.rejects(f.api.destroyReplica(), /background setting/);
  assert.equal(fs.existsSync(f.local), false);
  assert.equal(await f.replica.store.get("destroyPending"), true);
  for (const name of ["background", "scheduled", "delivered", "response"])
    assert.ok(f.state.calls.includes(name), `${name} was attempted`);
  f.replica.store.set = set;
  await f.api.destroyReplica();
  assert.equal(await f.replica.store.get("destroyPending"), null);
});

test("iOS erase succeeds without a registered background task or native music player", async (t) => {
  const f = await fixture(t, { platform: "ios" });
  f.state.registered = false;
  await f.api.destroyReplica();
  assert.equal(fs.existsSync(f.local), false);
  assert.equal(await f.replica.store.get("destroyPending"), null);
  assert.equal(f.state.calls.includes("background"), false);
  for (const name of ["scheduled", "delivered", "response"])
    assert.ok(f.state.calls.includes(name));
  assert.equal(fs.readFileSync(f.outside, "utf8"), "keep original");
});

test("a notification tapped while local files are being erased cannot navigate", async (t) => {
  const f = await fixture(t);
  f.state.connection = { linked: true, hubId: "old-hub" };
  let release;
  f.state.destroying = new Promise((resolve) => {
    release = resolve;
  });
  const delivered = [];
  f.api.subscribeNotificationResponse((item) => delivered.push(item));
  const erasing = f.api.destroyReplica();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.calls.includes("scheduled"), false, "system cleanup has not started yet");
  f.state.responseListener({
    notification: {
      request: {
        content: { data: { notice: { id: "old", action: "folder", volume: "old-folder" } } },
      },
    },
  });
  release();
  await erasing;
  assert.equal(delivered.length, 0);
  assert.equal(f.api.response(), null);
});
