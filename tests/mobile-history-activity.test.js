import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AWAY_MS,
  STRIP_DAYS,
  awayDue,
  awayText,
  barIndexAt,
  daySummary,
  localDay,
  stripBars,
} from "../apps/mobile/src/history-activity.js";
import { icons } from "../apps/mobile/src/icons.js";

const now = new Date(2026, 9, 9, 15, 30);
const key = (back) => localDay(new Date(2026, 9, 9 - back));
const names = (id) => ({ fold: "phone-fold", hub: "casa" })[id] || "Unknown device";

test("the strip has thirty bars, today last, with levels, a hairline and a mark for conflicts or deletions", () => {
  const bars = stripBars(
    [
      { day: key(3), changes: 4, deleted: 1, conflicts: 0 },
      { day: key(0), changes: 2, deleted: 0, conflicts: 1 },
      { day: key(40), changes: 99, deleted: 0, conflicts: 0 },
    ],
    now,
  );
  assert.equal(bars.length, STRIP_DAYS);
  assert.equal(bars.at(-1).key, key(0));
  assert.ok(bars.at(-1).today);
  assert.equal(bars.at(-1).caption, "Today, 2 changes");
  assert.equal(bars.at(-1).mark, "conflict");
  assert.equal(bars.at(-4).mark, "deleted");
  assert.equal(bars.at(-4).level, 9, "the busiest day is the tallest");
  assert.equal(bars.at(-1).level, 5);
  assert.equal(bars[0].level, 0, "a quiet day is a hairline");
  assert.equal(bars.at(-2).caption.endsWith("0 changes"), true);
  assert.equal(bars.some((bar) => bar.count === 99), false, "days outside the window are ignored");
  assert.equal(stripBars([{ day: key(1), changes: 1 }], now).at(-2).caption.endsWith("1 change"), true);
});

test("a touch position maps to one bar and stays inside the strip", () => {
  assert.equal(barIndexAt(0, 300), 0);
  assert.equal(barIndexAt(299, 300), 29);
  assert.equal(barIndexAt(-20, 300), 0);
  assert.equal(barIndexAt(900, 300), 29);
  assert.equal(barIndexAt(150, 300), 15);
  assert.equal(barIndexAt(10, 0), 29);
});

test("day summaries and the away line count changes per device", () => {
  assert.equal(daySummary(undefined, names), null);
  assert.deepEqual(daySummary({ changes: 4, devices: { hub: 1, fold: 3 } }, names), {
    text: "4 changes",
    devices: [
      { id: "fold", name: "phone-fold", count: 3 },
      { id: "hub", name: "casa", count: 1 },
    ],
  });
  const since = new Date(2026, 9, 8, 18, 40).toISOString();
  assert.equal(awayText({ since, changes: 14, devices: { fold: 9, hub: 5 } }, names, now), "Since yesterday 18:40 · 14 changes · phone-fold 9 · casa 5");
  assert.equal(awayText({ since: new Date(2026, 9, 9, 8, 5).toISOString(), changes: 1, devices: {} }, names, now), "Since today 08:05 · 1 change");
});

test("the away banner needs four hours", () => {
  const at = Date.now();
  assert.equal(awayDue(at - AWAY_MS + 1000, at), false);
  assert.equal(awayDue(at - AWAY_MS, at), true);
  assert.equal(awayDue(0, at), false, "a first launch is not an absence");
});

test("the phone History wires the strip, the banner, the day summaries, the jump and the Fold pane", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const parts = fs.readFileSync(new URL("../apps/mobile/src/HistoryActivity.jsx", import.meta.url), "utf8");
  assert.match(app, /<ActivityStrip/);
  assert.match(app, /<AwayBanner/);
  assert.match(app, /<DayGroup/);
  assert.match(app, /\/v1\/activity-days\?/);
  assert.match(app, /historyFilter === "revisions" \? historyDays : null/);
  assert.match(app, /const twoPane = wide && !compact/);
  assert.match(parts, /accessibilityRole="adjustable"/);
  const theme = fs.readFileSync(new URL("../apps/mobile/src/theme.js", import.meta.url), "utf8");
  assert.match(theme, /awayDismiss: \{\s*width: g\.touchControlHeight/);
  assert.match(theme, /activityBars: \{[^}]*height: g\.touchControlHeight \+ 16/);
  for (const name of ["history", "close", "devices"]) assert.ok(icons[name], name);
});
