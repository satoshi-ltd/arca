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
