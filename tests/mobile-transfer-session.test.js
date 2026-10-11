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

test("Android never stops the transfer service before it is in the foreground, which would kill the app and its music", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (name) =>
    readFile(new URL(`../apps/mobile/modules/arca-network/android/src/main/java/expo/modules/arcanetwork/${name}`, import.meta.url), "utf8");
  const module = await read("ArcaNetworkModule.kt");
  const service = await read("TransferService.kt");
  const start = module.slice(module.indexOf('AsyncFunction("startTransfer")'), module.indexOf('AsyncFunction("stopTransfer")'));
  const stop = module.slice(module.indexOf('AsyncFunction("stopTransfer")'), module.indexOf('AsyncFunction("transferProgress")'));
  assert.ok(start.indexOf("TransferService.gate.requested()") >= 0 && start.indexOf("TransferService.gate.requested()") < start.indexOf("startForegroundService"));
  assert.match(stop, /if \(TransferService\.gate\.released\(\)\)\s+appContext\.reactContext\?\.let \{ it\.stopService\(/);
  assert.equal(stop.match(/stopService/g).length, 1);
  const created = service.slice(service.indexOf("override fun onCreate()"), service.indexOf("private fun notification("));
  assert.ok(created.indexOf("gate.promoted()") > created.lastIndexOf("startForeground(ID"));
  assert.match(service, /else if \(!gate\.keep\(\)\) stopSelf\(\)\s+else super\.onStartCommand\(intent, flags, startId\)/);
  for (const reason of ["paused", "timeout", "closed"])
    assert.match(service, new RegExp(`onStopped\\?\\.invoke\\("${reason}"\\); halt\\(\\)`));
  assert.match(service, /private fun halt\(\) \{ gate\.ended\(\); stopSelf\(\) \}/);
  assert.match(service, /override fun onDestroy\(\) \{\s+instance = null\s+gate\.ended\(\)/, "a service the system destroyed is never stopped again from outside");
});
