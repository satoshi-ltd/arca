import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { blockLabel, completeDays, galleryComplete, galleryCounts, mediaSummary, dayBlocks, dayHeading, dayPlan, localMonths, monthSections, planCell, shownMonths } from "../apps/mobile/src/gallery-days.js";
import { monthLabel, railMonthLabel } from "../apps/mobile/src/gallery-timeline.js";
import { galleryLayout, galleryWindow, itemOffset } from "../apps/mobile/src/gallery-layout.js";
import { mediaSummary as desktopSummary } from "../apps/desktop/src/gallery-timeline-layout.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const photos = (day, count, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ path: `${day}/${from + i}.jpg`, date: `${day}T10:${String(i % 60).padStart(2, "0")}:00` }));

test("days read as a weekday, a date and the year only when it is not the current one", () => {
  assert.equal(dayHeading("2026-09-12", 2026), "Saturday 12 September");
  assert.equal(dayHeading("2025-12-31", 2026), "Wednesday 31 December 2025");
  assert.equal(dayHeading("", 2026), "Date unknown");
});

test("every day keeps its own heading, however few photos it holds", () => {
  const items = [...photos("2026-09-12", 12), ...photos("2026-09-11", 3), ...photos("2026-09-10", 1), ...photos("2026-09-09", 2), ...photos("2026-09-08", 9)];
  const blocks = dayBlocks(items);
  assert.deepEqual(blocks.map((b) => [b.day, b.count]), [["2026-09-12", 12], ["2026-09-11", 3], ["2026-09-10", 1], ["2026-09-09", 2], ["2026-09-08", 9]]);
  assert.deepEqual(blocks.map((b) => blockLabel(b, 2026)), ["Saturday 12 September", "Friday 11 September", "Thursday 10 September", "Wednesday 9 September", "Tuesday 8 September"]);
});

test("a busy day is plain squares like any other day", () => {
  const plan = dayPlan(photos("2026-09-12", 10), { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
  const step = 84;
  assert.ok(plan.cells.every((cell) => cell.width === 80 && cell.height === 80));
  assert.deepEqual([plan.cells[0].left, plan.cells[0].top], [0, 28]);
  assert.deepEqual([plan.cells[4].left, plan.cells[4].top], [0, 28 + step]);
  assert.equal(plan.height, 28 + 3 * step - 4);
  const fold = dayPlan(photos("2026-09-12", 9), { columns: 6, tile: 60, gap: 4, currentYear: 2026 });
  assert.deepEqual([fold.cells[0].width, fold.cells[0].height], [60, 60]);
});

test("a UTC capture is filed under its local day, once, beside that day's other photos", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Asia/Bangkok";
  try {
    const items = [...photos("2026-09-28", 2), { path: "night.jpg", date: "2026-09-27T22:30:00.000Z" }, ...photos("2026-09-27", 2)];
    const blocks = dayBlocks(items);
    assert.deepEqual(blocks.map((b) => [b.day, b.indices]), [["2026-09-28", [0, 1, 2]], ["2026-09-27", [3, 4]]]);
    const plan = dayPlan(items, { columns: 4, tile: 80, gap: 4, currentYear: 2026 });
    assert.equal(plan.heads.length, 2);
    assert.deepEqual([plan.cells[2].left, plan.cells[2].top], [2 * 84, 28]);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("photos without a date read Date unknown, as on desktop", () => {
  assert.equal(monthLabel("undated"), "Date unknown");
  assert.equal(railMonthLabel("undated"), "Date unknown");
  assert.equal(blockLabel(dayBlocks([{ path: "x.jpg", date: null }])[0], 2026), "Date unknown");
});

test("a UTC capture whose local day falls in the next month is filed under that month", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Madrid";
  try {
    const night = { path: "night.jpg", date: "2026-09-30T23:30:00.000Z" };
    const view = new Map([
      ["2026-10", [{ path: "b.jpg", date: "2026-10-02T09:00:00" }, { path: "a.jpg", date: "2026-10-01T08:00:00" }]],
      ["2026-09", [night, { path: "c.jpg", date: "2026-09-29T10:00:00" }]],
      ["undated", [{ path: "u.jpg", date: null }]],
    ]);
    const months = localMonths(view);
    assert.deepEqual(months.get("2026-10").map((item) => item.path), ["b.jpg", "a.jpg", "night.jpg"]);
    assert.deepEqual(months.get("2026-09").map((item) => item.path), ["c.jpg"]);
    assert.equal(months.get("undated"), view.get("undated"), "untouched months keep their identity");
    const alone = localMonths(new Map([["2026-09", [night]]]));
    assert.deepEqual([...alone.keys()], ["2026-09", "2026-10"]);
    assert.deepEqual(alone.get("2026-09"), []);
    assert.deepEqual(dayBlocks(alone.get("2026-10")).map((block) => block.day), ["2026-10-01"]);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("a month gained only through local re-filing shows as a complete section, and a month that lost photos counts what it shows", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Madrid";
  try {
    const night = { path: "night.jpg", date: "2026-09-30T23:30:00.000Z" };
    const c = { path: "c.jpg", date: "2026-09-29T10:00:00" };
    const source = {
      timeline: [{ month: "2026-09", count: 2 }],
      months: { "2026-09": { items: [night, c], complete: true, next: null } },
    };
    const months = localMonths(new Map([["2026-09", [night, c]]]));
    const shown = shownMonths(source, months);
    assert.deepEqual(shown["2026-10"], { items: [night], fresh: 1, complete: true, next: null });
    const sections = monthSections(source, months, shown);
    assert.deepEqual(sections, [{ month: "2026-10", count: 1 }, { month: "2026-09", count: 1 }]);
    assert.deepEqual([...completeDays(sections, months, shown).keys()], ["2026-10", "2026-09"]);
    const plain = { timeline: [{ month: "2026-08", count: 3 }], months: { "2026-08": { items: [], complete: false } } };
    assert.equal(shownMonths(plain, new Map([["2026-08", []]])), plain.months, "nothing added keeps the hub's months");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("undated photos sit after every dated month, before and after their rows load", () => {
  const source = {
    timeline: [{ month: "2026-09", count: 1 }],
    undated: 3,
    months: { "2026-09": { items: [{ path: "a.jpg", date: "2026-09-02" }], complete: true, next: null } },
  };
  const months = new Map([["2026-09", source.months["2026-09"].items]]);
  assert.deepEqual(monthSections(source, months, source.months), [
    { month: "2026-09", count: 1 },
    { month: "undated", count: 3 },
  ]);
  const undated = [{ path: "u.jpg", date: null }];
  const loaded = { ...source, undated: 1, months: { ...source.months, undated: { items: undated, complete: true, next: null } } };
  assert.deepEqual(
    monthSections(loaded, new Map([...months, ["undated", undated]]), loaded.months).map((section) => section.month),
    ["2026-09", "undated"],
  );
  assert.deepEqual(monthSections({ ...source, undated: 0 }, months, source.months), [{ month: "2026-09", count: 1 }]);
  assert.equal(galleryComplete(source), false, "undated photos the hub has not paged yet keep the gallery incomplete");
  assert.equal(galleryComplete(loaded), true);
  assert.equal(galleryComplete({ ...source, undated: 0 }), true);
});

test("photos within a day run newest first by instant, however the hub ordered their text", () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const night = { path: "night.jpg", date: "2026-09-27T02:30:00.000Z" };
    const late = { path: "late.jpg", date: "2026-09-26T23:00:00" };
    const c = { path: "c.jpg", date: "2026-09-26T10:00:00" };
    const months = localMonths(new Map([["2026-09", [night, late, c]]]));
    assert.deepEqual(months.get("2026-09").map((item) => item.path), ["late.jpg", "night.jpg", "c.jpg"]);
    assert.deepEqual(dayBlocks(months.get("2026-09")).map((block) => block.indices), [[0, 1, 2]]);
    const sorted = [late, c];
    assert.equal(localMonths(new Map([["2026-09", sorted]])).get("2026-09"), sorted, "an ordered month keeps its identity");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("the phone gallery builds its sections from the shared month helpers", () => {
  const screen = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(screen, /localMonths\(hubMonths\)[\s\S]*shownMonths\(source, months\)[\s\S]*monthSections\(source, months, shown\)[\s\S]*completeDays\(sections, months, shown\)/);
});

test("consecutive days share rows: each day starts in the next free cell with its label above it", () => {
  const items = [...photos("2026-09-12", 1), ...photos("2026-09-11", 2), ...photos("2026-09-10", 1), ...photos("2026-09-09", 1), ...photos("2026-09-08", 5)];
  const plan = dayPlan(items, { columns: 3, tile: 110, gap: 4, currentYear: 2026 });
  const step = 114;
  const places = plan.cells.map((cell) => [cell.left / step, cell.top]);
  assert.deepEqual(places.map(([column]) => column), [0, 1, 2, 0, 1, 2, 0, 1, 2, 0], "no empty cell before the month's end");
  assert.deepEqual(plan.cells.map((cell) => cell.top), [28, 28, 28, 28 + step + 28, 28 + step + 28, 28 + step + 28, 2 * step + 56, 2 * step + 56, 2 * step + 56, 3 * step + 56]);
  assert.deepEqual(plan.heads.map((head) => [head.left / step, head.top]), [[0, 0], [1, 0], [0, 28 + step], [1, 28 + step], [2, 28 + step]]);
  assert.deepEqual(plan.heads.map((head) => head.width), [110, 2 * step - 4, 110, 110, 110], "a label spans its day's cells in that row");
  assert.equal(plan.height, 3 * step + 56 + 110, "a row where no day starts reserves no label room");
});

test("a day longer than the cells left continues on the next rows with one label", () => {
  const items = [...photos("2026-09-12", 2), ...photos("2026-09-11", 40)];
  const fold = dayPlan(items, { columns: 6, tile: 60, gap: 4, currentYear: 2026 });
  assert.equal(fold.heads.length, 2);
  assert.deepEqual([fold.heads[1].left, fold.heads[1].top], [2 * 64, 0]);
  assert.equal(fold.heads[1].width, 4 * 64 - 4);
  assert.deepEqual([fold.cells[2].left, fold.cells[2].top], [128, 28]);
  assert.deepEqual([fold.cells[6].left, fold.cells[6].top], [0, 28 + 64]);
  assert.equal(fold.height, 28 + 6 * 64 + 60);
});

test("a day label shortens to fit above its cells and shows the count only when it fits", () => {
  const items = [...photos("2026-09-12", 3), ...photos("2026-09-11", 1), ...photos("2026-09-10", 2)];
  const plan = dayPlan(items, { columns: 3, tile: 110, gap: 4, currentYear: 2026 });
  assert.deepEqual(plan.heads.map((head) => [head.label, head.counted]), [
    ["Saturday 12 September", true],
    ["Fri 11 Sep", false],
    ["Thursday 10 September", false],
  ]);
  const fold = dayPlan([...photos("2026-09-12", 1), ...photos("2026-09-11", 1)], { columns: 6, tile: 60, gap: 4, currentYear: 2026 });
  assert.deepEqual(fold.heads.map((head) => head.label), ["12", "11"], "a cell too narrow for the short date keeps the day number");
});

test("days sharing a row leave room before the next label, mark a mid-row start and count only when they have the room", () => {
  const shared = [...photos("2026-09-12", 2), ...photos("2026-09-11", 1), ...photos("2026-09-10", 1)];
  const plain = dayPlan(shared, { columns: 4, tile: 90, gap: 4, currentYear: 2026 });
  assert.deepEqual(plain.heads.map((head) => [head.label, head.counted, head.tick]), [
    ["Sat 12 Sep", true, false],
    ["11 Sep", false, true],
    ["10 Sep", false, true],
  ], "the full name would touch the next day's label, so it shortens");
  const large = dayPlan(shared, { columns: 4, tile: 90, gap: 4, currentYear: 2026, fontScale: 1.3 });
  assert.deepEqual(large.heads.map((head) => [head.label, head.counted]), [
    ["Sat 12 Sep", false],
    ["11 Sep", false],
    ["10 Sep", false],
  ], "larger system text drops the count first");
  for (const columns of [3, 4, 6])
    for (const fontScale of [1, 1.3]) {
      const options = { columns, tile: 400, gap: 4, currentYear: 2026, fontScale };
      const between = dayPlan([...photos("2026-09-12", 1), ...photos("2026-09-11", 1), ...photos("2026-09-10", columns - 2)], options);
      assert.equal(between.heads[0].counted, false, `${columns} columns at ${fontScale}: a one-cell day followed in its row hides its count`);
      assert.deepEqual(between.heads.map((head) => head.tick), [false, true, true]);
      assert.equal(between.heads[2].counted, (columns - 2) * 2 >= columns, `${columns} columns at ${fontScale}: a day spanning half the row counts`);
      const alone = dayPlan([...photos("2026-09-12", columns), ...photos("2026-09-11", 1)], options);
      assert.deepEqual(alone.heads.map((head) => [head.tick, head.counted]), [[false, true], [false, true]], `${columns} columns at ${fontScale}: a label alone in its row counts`);
      const plan = dayPlan([...photos("2026-09-12", 1), ...photos("2026-09-11", 2), ...photos("2026-09-10", 1), ...photos("2026-09-08", 7)], { ...options, tile: 100 });
      for (const head of plan.heads) {
        const next = plan.heads.find((other) => other.top === head.top && other.left > head.left);
        const room = head.width - (next ? 12 : 0) - (head.tick ? 10 : 0);
        const used = head.label.length * 8.5 * fontScale + (head.counted ? `${head.count} photo${head.count === 1 ? "" : "s"}`.length * 7 * fontScale + 8 : 0);
        assert.ok(used <= room, `${columns}/${fontScale}: ${head.label} fits ${room}`);
        assert.equal(head.tick, head.left > 0);
      }
      for (const tile of { 3: [110, 128], 4: [80, 95], 6: [60, 110] }[columns]) {
        const cells = dayPlan([...photos("2026-09-12", 1), ...photos("2026-09-11", 1), ...photos("2026-09-10", 1), ...photos("2026-09-08", 7)], { columns, tile, gap: 4, currentYear: 2026, fontScale });
        for (const head of cells.heads) {
          const next = cells.heads.find((other) => other.top === head.top && other.left > head.left);
          const room = head.width - (next ? 12 : 0) - (head.tick ? 10 : 0);
          assert.ok(head.label.length * 8.5 * fontScale <= room, `${columns} columns of ${tile} at ${fontScale}: "${head.label}" never ellipsizes in ${room}`);
        }
        assert.ok(cells.heads.every((head) => !/^\d+$/.test(head.label) || tile <= 80), `${columns} columns of ${tile} at ${fontScale}: a phone cell keeps at least the month`);
      }
    }
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
  assert.equal(planCell(plan, 100, 40).index, 1);
  assert.equal(planCell(plan, 190, 40).index, 2);
  assert.equal(planCell(plan, 0, 10).index, 0);
});

test("the gallery draws day headings from the plan and each cell at its planned size", () => {
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /galleryLayout\(\s+sections,\s+width,\s+density === "years" \? compactColumns\(columns\) : density,\s+dayItems,\s+fontScale,/);
  assert.match(gallery, /const \{ s, wide, fontScale = 1 \} = useDesign\(\);/);
  assert.match(gallery, /\{head\.tick && <View style=\{s\.dayTick\} \/>\}\s+<Text numberOfLines=\{1\} style=\{\[s\.rowTitle, s\.dayLabel\]\}>/);
  assert.match(read("../apps/mobile/src/theme.js"), /dayTick: \{ width: 2, alignSelf: "stretch", backgroundColor: c\.line \}/);
  assert.match(read("../apps/mobile/src/App.jsx"), /fontScale: fontScale \* textScale\(prefs\.textSize\),/);
  assert.match(gallery, /size=\{cell\.width \|\| layout\.tile\}\s+height=\{cell\.height\}/);
  assert.match(gallery, /section\.plan\s+\? planCell\(section\.plan/);
  assert.match(gallery, /style=\{\[s\.dayHead, \{ top: section\.gridTop \+ head\.top, left: head\.left, width: head\.width \}\]\}/);
  assert.match(gallery, /\{head\.counted && <Text style=\{s\.caption\}>\{photoCount\(head\.count\)\}<\/Text>\}/);
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
  assert.equal(blockLabel(blocks[0], 2026), "Day unknown");
  const mixed = [{ path: "a.jpg", date: "2026-09-05T10:00:00" }, { path: "b.jpg", date: "2026-09" }, { path: "c.jpg", date: "2026-09" }];
  const labels = dayBlocks(mixed).map((block) => blockLabel(block, 2026));
  assert.ok(labels.every((label) => !label.includes("undefined")), labels.join("|"));
  assert.equal(blockLabel(dayBlocks([{ path: "x.jpg", date: "" }])[0], 2026), "Date unknown");
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

test("the gallery header counts videos apart from photos, from the timeline or what is loaded", () => {
  const hub = { timeline: [{ month: "2026-09", count: 2, videos: 2 }], undated: 0, undatedVideos: 0, total: 2, months: {} };
  assert.deepEqual(galleryCounts(hub, []), { photos: 0, videos: 2 });
  const mixed = { timeline: [{ month: "2026-09", count: 3, videos: 1 }], undated: 1, undatedVideos: 0, total: 4, months: {} };
  assert.deepEqual(galleryCounts(mixed, []), { photos: 3, videos: 1 });
  const local = { timeline: [], undated: 0, total: 0, months: {} };
  const loaded = [{ path: "a.mp4", kind: "video" }, { path: "b.mp4", kind: "video" }];
  assert.deepEqual(galleryCounts(local, loaded), { photos: 0, videos: 2 });
});

test("the phone words a gallery summary exactly as desktop does", () => {
  assert.equal(mediaSummary(0, 2), "2 videos");
  assert.equal(mediaSummary(3, 1), "3 photos · 1 video");
  assert.equal(mediaSummary(1, 0), "1 photo");
  for (const [photos, videos] of [[0, 0], [0, 1], [0, 2], [1, 0], [3, 1], [3046, 593], [1, 1]])
    assert.equal(mediaSummary(photos, videos), desktopSummary(photos, videos));
});
