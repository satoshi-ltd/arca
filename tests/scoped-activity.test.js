import test from "node:test";
import assert from "node:assert/strict";
import {
  scopedActivity,
  historyFolderIds,
} from "../packages/core/scoped-activity.js";
test("selected history merges pages without leaking other folders or skipping revisions", async () => {
  const all = Array.from({ length: 24 }, (_, i) => ({
    rev: 24 - i,
    volume: ["a", "hidden", "b"][i % 3],
  }));
  const calls = [];
  const fetchPage = async (q) => {
    calls.push(q.get("volume"));
    const rows = all.filter(
      (r) =>
        r.volume === q.get("volume") && r.rev < Number(q.get("before") || 100),
    );
    const n = Number(q.get("limit"));
    return {
      versions: rows.slice(0, n),
      next: rows.length > n ? rows[n - 1].rev : null,
    };
  };
  const seen = [];
  const q = new URLSearchParams({ limit: "3" });
  do {
    const page = await scopedActivity(fetchPage, ["a", "b"], q);
    seen.push(...page.versions);
    if (!page.next) break;
    q.set("before", page.next);
  } while (true);
  assert.deepEqual(
    seen,
    all.filter((r) => r.volume !== "hidden"),
  );
  assert.ok(calls.every((id) => id === "a" || id === "b"));
  assert.deepEqual(await scopedActivity(fetchPage, [], new URLSearchParams()), {
    versions: [],
    next: null,
  });
  await assert.rejects(
    scopedActivity(fetchPage, ["a"], new URLSearchParams({ volume: "hidden" })),
    /Select/,
  );
});

test("every folder page is requested before any settles and one failure fails the call", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const pending = scopedActivity(
    async (q) => {
      started.push(q.get("volume"));
      await gate;
      return { versions: [], next: null };
    },
    ["a", "b", "c"],
    new URLSearchParams(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"]);
  release();
  await pending;
  await assert.rejects(
    scopedActivity(
      async (q) => {
        if (q.get("volume") === "b") throw new Error("unreachable");
        return { versions: [], next: null };
      },
      ["a", "b"],
      new URLSearchParams(),
    ),
    /unreachable/,
  );
});

test("retained copies of deleted shares do not block history of current selected folders", async () => {
  const ids = historyFolderIds(
    [
      { id: "removed", selected: 1 },
      { id: "kept", selected: 1 },
      { id: "unselected", selected: 0 },
    ],
    [{ id: "kept" }, { id: "unselected" }],
  );
  const calls = [];
  const page = await scopedActivity(
    async (q) => {
      calls.push(q.get("volume"));
      if (q.get("volume") === "removed") throw new Error("Unknown volume");
      return { versions: [{ volume: "kept", rev: 7 }], next: null };
    },
    ids,
    new URLSearchParams(),
  );
  assert.deepEqual(calls, ["kept"]);
  assert.deepEqual(page.versions, [{ volume: "kept", rev: 7 }]);
});
test("an offline page that was saved, even empty, tells the window it is saved data", async () => {
  const query = new URLSearchParams({ filter: "conflicts" });
  assert.deepEqual(
    await scopedActivity(async () => ({ offline: true, savedAt: 5, versions: [], next: null }), ["a", "b"], query),
    { offline: true, saved: true, versions: [], next: null },
  );
  assert.deepEqual(
    await scopedActivity(async () => ({ offline: true, versions: [], next: null }), ["a"], query),
    { offline: true, versions: [], next: null },
    "nothing saved stays unmarked",
  );
  assert.deepEqual(
    await scopedActivity(async (q) => (q.get("volume") === "a" ? { offline: true, savedAt: 5, versions: [], next: null } : { offline: true, versions: [], next: null }), ["a", "b"], query),
    { offline: true, versions: [], next: null },
    "a folder with nothing saved keeps it honest",
  );
  assert.equal("saved" in (await scopedActivity(async () => ({ versions: [], next: null }), ["a"], query)), false, "online answers carry no flag");
});
