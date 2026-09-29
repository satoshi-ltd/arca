import test from "node:test";
import assert from "node:assert/strict";
import { coalescedRun } from "../apps/mobile/src/folder-listing.js";

test("folder walks never restart: requests during a walk run it once more afterwards", async () => {
  const jobs = new Map();
  const runs = [];
  let release;
  let settled = 0;
  const gate = () => new Promise((resolve) => (release = resolve));
  const run = async (first) => {
    runs.push(first);
    await gate();
  };
  const first = coalescedRun(jobs, "hub:photos", run, () => settled++);
  const second = coalescedRun(jobs, "hub:photos", run, () => settled++);
  const third = coalescedRun(jobs, "hub:photos", run, () => settled++);
  assert.equal(second, first, "callers wait for the same walk");
  assert.equal(third, first);
  await new Promise(setImmediate);
  assert.deepEqual(runs, [true]);
  release();
  await new Promise(setImmediate);
  assert.deepEqual(runs, [true, false], "coalesced requests run exactly one more walk");
  release();
  await first;
  assert.deepEqual(runs, [true, false]);
  assert.equal(settled, 1);
  assert.equal(jobs.size, 0);
  const other = coalescedRun(jobs, "hub:notes", async () => runs.push("notes"));
  await other;
  assert.equal(runs.at(-1), "notes", "other folders are independent");
});

test("a failed walk clears its slot so the next request walks again", async () => {
  const jobs = new Map();
  let settled = 0;
  await assert.rejects(
    coalescedRun(jobs, "k", async () => { throw new Error("disk"); }, () => settled++),
    /disk/,
  );
  assert.equal(settled, 1);
  assert.equal(jobs.size, 0);
  let walked = false;
  await coalescedRun(jobs, "k", async () => { walked = true; });
  assert.equal(walked, true);
});
