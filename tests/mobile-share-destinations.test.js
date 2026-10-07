import test from "node:test";
import assert from "node:assert/strict";
import {
  DESTINATION_LIMIT,
  destinationLabel,
  destinationUsage,
  loadDestinations,
  pruneDestinations,
  recentDestinations,
  recordDestination,
  saveDestination,
} from "../apps/mobile/src/share-destinations.js";

const DAY = 86400000;
const folders = [
  { id: "v-docs", name: "documents" },
  { id: "v-alpi", name: "alpi-workspace" },
];

test("recording a destination counts its uses, normalises the subfolder and ranks by use, then recency", () => {
  let ledger = recordDestination([], "v-docs", " /receipts/2026/ ", 1000);
  assert.deepEqual(ledger, [
    { volume: "v-docs", directory: "receipts/2026", uses: 1, last: 1000 },
  ]);
  ledger = recordDestination(ledger, "v-alpi", "", 2000);
  ledger = recordDestination(ledger, "v-docs", "receipts/2026", 3000);
  assert.deepEqual(
    ledger.map((entry) => [
      entry.volume,
      entry.directory,
      entry.uses,
      entry.last,
    ]),
    [
      ["v-docs", "receipts/2026", 2, 3000],
      ["v-alpi", "", 1, 2000],
    ],
  );
  ledger = recordDestination(ledger, "v-docs", "", 4000);
  assert.deepEqual(
    ledger.map((entry) => [entry.volume, entry.directory, entry.uses]),
    [
      ["v-docs", "receipts/2026", 2],
      ["v-docs", "", 1],
      ["v-alpi", "", 1],
    ],
    "among single uses the most recent comes first",
  );
});

test("the ledger keeps at most twenty destinations and drops the least used, oldest one", () => {
  let ledger = [];
  for (let i = 0; i < DESTINATION_LIMIT; i++)
    ledger = recordDestination(ledger, "v-docs", `d${i}`, 1000 + i);
  ledger = recordDestination(ledger, "v-docs", "d5", 5000);
  ledger = recordDestination(ledger, "v-docs", "newest", 6000);
  assert.equal(ledger.length, DESTINATION_LIMIT);
  assert.equal(ledger[0].directory, "d5");
  assert.ok(ledger.some((entry) => entry.directory === "newest"));
  assert.ok(
    !ledger.some((entry) => entry.directory === "d0"),
    "the oldest single-use entry is gone",
  );
});

test("recent destinations show at most three, only for folders still selected, with their folder attached", () => {
  const ledger = [
    { volume: "v-gone", directory: "", uses: 9, last: 9000 },
    { volume: "v-docs", directory: "receipts/2026", uses: 14, last: 3000 },
    { volume: "v-alpi", directory: "inbox", uses: 3, last: 8000 },
    { volume: "v-docs", directory: "", uses: 1, last: 7000 },
    { volume: "v-docs", directory: "old", uses: 1, last: 1000 },
  ];
  const recent = recentDestinations(ledger, folders);
  assert.deepEqual(
    recent.map((entry) => [entry.folder.name, entry.directory]),
    [
      ["documents", "receipts/2026"],
      ["alpi-workspace", "inbox"],
      ["documents", ""],
    ],
  );
  assert.deepEqual(
    pruneDestinations(ledger, folders).map((entry) => entry.volume),
    ["v-docs", "v-alpi", "v-docs", "v-docs"],
  );
  assert.deepEqual(recentDestinations([], folders), []);
});

test("labels name the folder and subfolder and say how often and when a destination was used", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const entry = (uses, daysAgo, directory = "") => ({
    volume: "v-docs",
    directory,
    uses,
    last: now - daysAgo * DAY,
    folder: folders[0],
  });
  assert.equal(destinationLabel(entry(1, 0)), "documents");
  assert.equal(
    destinationLabel(entry(1, 0, "receipts/2026")),
    "documents / receipts/2026",
  );
  assert.equal(destinationUsage(entry(1, 0), now), "Used once · today");
  assert.equal(destinationUsage(entry(2, 1), now), "Used 2 times · yesterday");
  assert.equal(
    destinationUsage(entry(14, 2), now),
    "Used 14 times · 2 days ago",
  );
  assert.equal(destinationUsage(entry(3, 8), now), "Used 3 times · last week");
  assert.equal(destinationUsage(entry(1, 21), now), "Used once · 3 weeks ago");
  assert.equal(destinationUsage(entry(1, 27), now), "Used once · 3 weeks ago");
  assert.equal(destinationUsage(entry(1, 28), now), "Used once · last month");
  assert.equal(
    destinationUsage(entry(1, 359), now),
    "Used once · 11 months ago",
  );
  assert.equal(
    destinationUsage(entry(1, 360), now),
    "Used once · over a year ago",
  );
  assert.equal(destinationUsage(entry(1, 45), now), "Used once · last month");
  assert.equal(
    destinationUsage(entry(1, 100), now),
    "Used once · 3 months ago",
  );
  assert.equal(
    destinationUsage(entry(1, 400), now),
    "Used once · over a year ago",
  );
});

test("saving records into the phone's own settings row for the hub and prunes folders no longer selected", async () => {
  const rows = new Map();
  const store = {
    get: async (key, fallback) => (rows.has(key) ? rows.get(key) : fallback),
    set: async (key, value) =>
      void rows.set(key, JSON.parse(JSON.stringify(value))),
  };
  await saveDestination(
    store,
    "hub-1",
    folders,
    "v-docs",
    "receipts/2026",
    1000,
  );
  await saveDestination(store, "hub-1", folders, "v-alpi", "inbox", 2000);
  await saveDestination(
    store,
    "hub-1",
    folders,
    "v-docs",
    "receipts/2026",
    3000,
  );
  assert.deepEqual([...rows.keys()], ["shareDestinations:hub-1"]);
  const recent = await loadDestinations(store, "hub-1", folders);
  assert.deepEqual(
    recent.map((entry) => [entry.folder.name, entry.directory, entry.uses]),
    [
      ["documents", "receipts/2026", 2],
      ["alpi-workspace", "inbox", 1],
    ],
  );
  await saveDestination(store, "hub-1", [folders[1]], "v-alpi", "", 4000);
  assert.deepEqual(
    rows.get("shareDestinations:hub-1").map((entry) => entry.volume),
    ["v-alpi", "v-alpi"],
    "an unselected folder's destinations leave the ledger",
  );
  assert.deepEqual(
    await loadDestinations(store, "hub-2", folders),
    [],
    "another hub has its own ledger",
  );
  rows.set("shareDestinations:hub-3", null);
  assert.deepEqual(
    await loadDestinations(store, "hub-3", folders),
    [],
    "a damaged row reads as no history",
  );
  await saveDestination(store, "hub-3", folders, "v-docs", "", 5000);
  assert.deepEqual(
    rows
      .get("shareDestinations:hub-3")
      .map((entry) => [entry.volume, entry.uses]),
    [["v-docs", 1]],
    "and is replaced by the next save",
  );
});
