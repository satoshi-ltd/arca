import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { blockLabel, dayBlocks, dayHeading, dayPlan, dayRange, planCell } from "../apps/mobile/src/gallery-days.js";
import { galleryLayout, galleryWindow, itemOffset } from "../apps/mobile/src/gallery-layout.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const photos = (day, count, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ path: `${day}/${from + i}.jpg`, date: `${day}T10:${String(i % 60).padStart(2, "0")}:00` }));

test("days read as a weekday, a date and the year only when it is not the current one", () => {
  assert.equal(dayHeading("2026-09-12", 2026), "Saturday 12 September");
  assert.equal(dayHeading("2025-12-31", 2026), "Wednesday 31 December 2025");
  assert.equal(dayHeading("", 2026), "Undated");
  assert.equal(dayRange("2026-09-10", "2026-09-10", 2026), "10 September");
  assert.equal(dayRange("2026-09-08", "2026-09-10", 2026), "8 – 10 September");
  assert.equal(dayRange("2026-08-30", "2026-09-02", 2026), "30 August – 2 September");
});

test("a day of fewer than four photos folds into one Quiet days block with its neighbours", () => {
  const items = [...photos("2026-09-12", 12), ...photos("2026-09-11", 3), ...photos("2026-09-10", 1), ...photos("2026-09-09", 2), ...photos("2026-09-08", 9)];
  const blocks = dayBlocks(items);
  assert.deepEqual(blocks.map((b) => [b.kind, b.start, b.count]), [["day", 0, 12], ["quiet", 12, 6], ["day", 18, 9]]);
  assert.equal(blockLabel(blocks[0], 2026), "Saturday 12 September");
  assert.equal(blockLabel(blocks[1], 2026), "Quiet days · 9 – 11 September");
  assert.equal(blockLabel(dayBlocks(photos("2026-09-11", 2))[0], 2026), "Friday 11 September");
});

test("a busy day opens with a hero tile two columns wide and the rest flow around it", () => {
  const plan = dayPlan(photos("2026-09-12", 10), { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
  const step = 84;
  assert.deepEqual(plan.cells[0], { top: 28, left: 0, width: 164, height: 164 });
  assert.deepEqual([plan.cells[1].left, plan.cells[1].top], [2 * step, 28]);
  assert.deepEqual([plan.cells[2].left, plan.cells[2].top], [3 * step, 28]);
  assert.deepEqual([plan.cells[3].left, plan.cells[3].top], [2 * step, 28 + step]);
  assert.deepEqual([plan.cells[5].left, plan.cells[5].top], [0, 28 + 2 * step], "the next row clears the hero");
  assert.equal(plan.height, 28 + 4 * step - 4);
  assert.equal(plan.heads.length, 1);
});

test("the Fold's six columns give the hero three by two and a day under eight photos has none", () => {
  const fold = dayPlan(photos("2026-09-12", 9), { columns: 6, tile: 60, gap: 4, currentYear: 2026 });
  assert.deepEqual([fold.cells[0].width, fold.cells[0].height], [3 * 64 - 4, 2 * 64 - 4]);
  const small = dayPlan(photos("2026-09-12", 7), { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
  assert.deepEqual([small.cells[0].width, small.cells[0].height], [80, 80]);
  assert.equal(small.cells.length, 7);
});

test("blocks are spaced by a gap and every item has a place", () => {
  const items = [...photos("2026-09-12", 5), ...photos("2026-09-11", 6)];
  const plan = dayPlan(items, { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
  assert.equal(plan.heads.length, 2);
  assert.equal(plan.heads[1].top, 28 + 2 * 84 - 4 + 12);
  assert.ok(plan.cells.every(Boolean));
});

test("the layout uses a day plan for a complete month and falls back to the month grid otherwise", () => {
  const items = photos("2026-09-12", 10);
  const days = new Map([["2026-09", items]]);
  const layout = galleryLayout([{ month: "2026-09", count: 10 }, { month: "2026-08", count: 5 }], 344, 4, days);
  const [september, august] = layout.sections;
  assert.ok(september.plan);
  assert.equal(august.plan, undefined);
  assert.equal(august.height, 30 + 2 * layout.step - layout.gap);
  assert.equal(september.height, 30 + september.plan.height);
  const mismatch = galleryLayout([{ month: "2026-09", count: 11 }], 344, 4, days);
  assert.equal(mismatch.sections[0].plan, undefined, "a count that does not match the loaded items keeps the month grid");
  assert.equal(itemOffset(layout, "2026-09", 0), september.gridTop + 28);
  assert.equal(itemOffset(layout, "2026-09", 3), september.gridTop + september.plan.cells[3].top);
});

test("the window lists only the planned cells and headings in view", () => {
  const days = new Map([["2026-09", [...photos("2026-09-12", 10), ...photos("2026-09-01", 20)]]]);
  const layout = galleryLayout([{ month: "2026-09", count: 30 }], 344, 4, days);
  const [row] = galleryWindow(layout, 0, 200);
  assert.ok(row.cells.includes(0));
  assert.ok(!row.cells.includes(29));
  assert.equal(row.heads[0].label.startsWith("Saturday"), true);
});

test("a touch picks the cell under it, or the nearest", () => {
  const plan = dayPlan(photos("2026-09-12", 10), { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
  assert.equal(planCell(plan, 10, 40).index, 0);
  assert.equal(planCell(plan, 190, 40).index, 1);
  assert.equal(planCell(plan, 0, 10).index, 0);
});

test("the gallery draws day headings from the plan and the hero tile at its own size", () => {
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /galleryLayout\(\s+sections,\s+width,\s+density === "years" \? compactColumns\(columns\) : density,\s+dayItems,/);
  assert.match(gallery, /size=\{cell\.width \|\| layout\.tile\}\s+height=\{cell\.height\}/);
  assert.match(gallery, /section\.plan\s+\? planCell\(section\.plan/);
});

test("the gallery names its levels, offers them as actions and a Fold control, and brings back On this day", () => {
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /\{ base: "Days", compact: "Months", years: "Years" \}\[level\]/);
  assert.match(gallery, /name: "days", label: "Show days"/);
  assert.match(gallery, /\{wide && \(\s+<SegmentedControl/);
  assert.match(gallery, /\/v1\/gallery\/memories\?/);
  assert.match(gallery, /slice\(0, 3\)/);
  assert.match(gallery, /toValue: 0,\s+delay: duration\(1000\)/);
});

test("month-only and missing dates never produce broken headings", () => {
  const monthOnly = Array.from({ length: 10 }, (_, i) => ({ path: `m${i}.jpg`, date: "2026-09" }));
  const blocks = dayBlocks(monthOnly);
  assert.equal(blocks.length, 1);
  assert.equal(blockLabel(blocks[0], 2026), "September 2026");
  const plan = dayPlan(monthOnly, { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
  assert.equal(plan.cells[0].width, 80, "an undated day never gets a hero");
  const mixed = [{ path: "a.jpg", date: "2026-09-05T10:00:00" }, { path: "b.jpg", date: "2026-09" }, { path: "c.jpg", date: "2026-09" }];
  const labels = dayBlocks(mixed).map((block) => blockLabel(block, 2026));
  assert.ok(labels.every((label) => !label.includes("undefined")), labels.join("|"));
  assert.equal(blockLabel(dayBlocks([{ path: "x.jpg", date: "" }])[0], 2026), "Undated");
});

test("a pending flight is seen by the page before the hook takes it", () => {
  const motion = read("../apps/mobile/src/motion.js");
  assert.match(motion, /ready: !\(active && key && hasFlight\(key\)\)/);
  const page = read("../apps/mobile/src/NowPlayingPage.jsx");
  assert.match(page, /flying\.current = visible && hasFlight\("cover"\)/);
  assert.match(page, /const lift = flying\.current \? 0 : height \* 0\.2;/);
  const music = read("../apps/mobile/src/MusicLibrary.jsx");
  assert.match(music, /setTimeout\(go, 150\)/);
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /if \(status\.busy\) setSyncDone\(false\);/);
});
