import test from "node:test";
import assert from "node:assert/strict";
import {
  coalescedRefresh,
  retainSnapshot,
} from "../apps/mobile/src/ui-refresh.js";
test("progress bursts produce one active read and one fresh trailing read", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const update = coalescedRefresh(async () => {
    calls++;
    if (calls === 1) await gate;
  });
  const first = update();
  for (let i = 0; i < 100; i++) assert.equal(update(), first);
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 2);
  await update();
  assert.equal(calls, 3);
});
test("failed refresh releases the queue for subsequent recovery", async () => {
  let calls = 0;
  const update = coalescedRefresh(async () => {
    if (++calls === 1) throw new Error("unavailable");
  });
  await assert.rejects(update(), /unavailable/);
  await update();
  assert.equal(calls, 2);
});
test("unchanged snapshots retain identity and runtime mutation cannot alter React state", () => {
  const runtime = { busy: true, progress: { files: 1 } };
  const first = retainSnapshot(null, runtime);
  assert.notEqual(first, runtime);
  assert.equal(retainSnapshot(first, { ...runtime }), first);
  runtime.progress.files = 2;
  assert.equal(first.progress.files, 1);
  const second = retainSnapshot(first, runtime);
  assert.notEqual(second, first);
  assert.equal(second.progress.files, 2);
});
