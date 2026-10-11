import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cardPreviews,
  coverPreviewSize,
  galleryDay,
  galleryMoment,
  galleryZoomStep,
  mediaSummary,
  photoFlow,
  pinchSteps,
  rowTarget,
  tilePreviewSize,
} from "../apps/desktop/src/gallery-timeline-layout.js";

const local = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("a photo's day is the local day its date names, and broken dates have none", () => {
  assert.equal(galleryDay("2026-09-20T11:06:00"), "2026-09-20");
  assert.equal(galleryDay("2026-09-27T22:30:00.000Z"), local("2026-09-27T22:30:00.000Z"));
  assert.equal(galleryDay("2026-09-20"), "2026-09-20");
  assert.equal(galleryDay("2026-09"), "2026-09");
  for (const broken of ["", null, undefined, "0000-00-00T00:00:00", "nonsense"])
    assert.equal(galleryDay(broken), "", String(broken));
  assert.equal(galleryMoment("nonsense"), null);
  assert.equal(galleryMoment("2026-09-20T11:06:00").getHours(), 11);
});

const wall = { width: 1000, target: 180, gap: 6 };
const rowsOf = (flow) => flow.rows.map((row) => flow.tiles.slice(row.start, row.end));
const right = (tiles) => tiles.at(-1).left + tiles.at(-1).width;

test("rows fill the width at the target height and the last row keeps it", () => {
  const flow = photoFlow([1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 0.75], wall);
  for (const tiles of rowsOf(flow).slice(0, -1)) {
    assert.ok(Math.abs(right(tiles) - 1000) < 0.5, `row fills ${right(tiles)}`);
    assert.ok(tiles[0].height <= 225);
  }
  assert.ok(flow.rows.at(-1).height <= 180);
  assert.equal(flow.tiles.length, 7);
});

test("a month is one continuous flow: rows sit one gap apart and reserve no label room", () => {
  const flow = photoFlow(Array(40).fill(1.33), wall);
  assert.equal(flow.labels, undefined);
  assert.ok(flow.rows.length > 5);
  for (let index = 1; index < flow.rows.length; index++) {
    const gap = flow.rows[index].top - (flow.rows[index - 1].top + flow.rows[index - 1].height);
    assert.ok(Math.abs(gap - 6) < 0.02, `row ${index} follows the previous one by one tile gap`);
  }
  for (const tiles of rowsOf(flow))
    for (let index = 1; index < tiles.length; index++)
      assert.ok(Math.abs(tiles[index].left - (tiles[index - 1].left + tiles[index - 1].width) - 6) < 0.02);
  assert.ok(Math.abs(flow.height - (flow.rows.at(-1).top + flow.rows.at(-1).height)) < 0.02);
});

test("a photo added later changes only the row it lands in and the row before it", () => {
  for (const [kept, added] of [
    [[1.5, 1.5, 1.5, 1.33, 1.33, 1.5, 1.5], [0.75, 1.5, 1.5]],
    [[1.33, 1.33, 1.33, 1.33], [1.33]],
    [[1.5, 1.5, 1.33, 0.75, 1.5], [3, 1.5]],
  ]) {
    const before = photoFlow(kept, wall);
    const after = photoFlow([...kept, ...added], wall);
    const from = Math.max(0, after.tiles[kept.length].row - 1);
    assert.deepEqual(after.tiles.filter((tile) => tile.row < from), before.tiles.filter((tile) => tile.row < from));
  }
  const before = photoFlow([1.33, 1.33, 1.33, 1.33], wall);
  const after = photoFlow([1.33, 1.33, 1.33, 1.33, 1.33], wall);
  assert.equal(after.tiles[4].row, 1, "the new photo starts the next row");
  assert.equal(before.tiles[0].height, 180);
  assert.ok(after.tiles[0].height > 180, "and the row above, until now the month's last, closes taller");
  const edge = after.tiles[3].left + after.tiles[3].width;
  assert.ok(Math.abs(edge - 1000) < 0.5, `the closed row fills the wall (${edge})`);
});

test("the gallery scroll keeps only its own anchor", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\n#photo-gallery \{[^}]*overflow-anchor: none;/);
  assert.match(css, /\n\.page:has\(#photo-gallery\) \{\s*overflow-anchor: none;\s*\}/);
});

test("a panorama on a narrow wall does not squash the row before it", () => {
  const flow = photoFlow([1.78, 4, 1.33], { ...wall, width: 234, target: 120 });
  assert.deepEqual(flow.rows.map((row) => row.end - row.start), [1, 1, 1]);
  assert.ok(flow.rows[0].height > 120 && flow.rows[0].height <= 150, String(flow.rows[0].height));
  assert.ok(flow.rows[1].height >= 234 / 4 - 1);
});

test("an On this day card asks for a preview whose short side covers the cropped card", () => {
  const card = [160, 120];
  assert.equal(coverPreviewSize(...card, 2, 1920, 1080), "medium", "a 16:9 photo at 2x needs 427 px long edges");
  assert.equal(coverPreviewSize(...card, 1, 1920, 1080), "thumb");
  assert.equal(coverPreviewSize(...card, 2, 1600, 1200), "thumb");
  assert.equal(coverPreviewSize(...card, 1, 1600, 1200), "thumb");
  assert.equal(coverPreviewSize(...card, 2, 1200, 1600), "medium", "a portrait photo fills the card's width");
  assert.equal(coverPreviewSize(...card, 1, 1200, 1600), "thumb");
  assert.equal(coverPreviewSize(...card, 2, 1000, 1000), "thumb");
  assert.equal(coverPreviewSize(...card, 1, 1000, 1000), "thumb");
  assert.equal(coverPreviewSize(240, 180, 2, 1920, 1080), "medium");
  assert.equal(coverPreviewSize(300, 225, 2, 1920, 1080), "large");
  assert.equal(coverPreviewSize(...card, 2), "thumb", "an unknown shape starts from the card's own fit until a preview shows its shape");
  assert.equal(coverPreviewSize(240, 180, 2), "medium");
});

test("a tile asks for the smallest preview with enough pixels for it", () => {
  assert.equal(tilePreviewSize(240, 180, 1), "thumb");
  assert.equal(tilePreviewSize(180, 180, 2), "thumb");
  assert.equal(tilePreviewSize(240, 180, 2), "medium");
  assert.equal(tilePreviewSize(400, 120, 1), "medium");
  assert.equal(tilePreviewSize(360, 270, 2), "medium");
  assert.equal(tilePreviewSize(361, 180, 2), "large");
  assert.equal(tilePreviewSize(900, 180, 1), "large");
});

test("a pinch walks Years, Months, Small, Medium and Large, and stops at both ends", () => {
  assert.deepEqual([rowTarget(1000, "small"), rowTarget(1000, "medium"), rowTarget(1000, "large")], [120, 180, 240]);
  assert.equal(rowTarget(700, "medium"), 140, "Medium is the wall's own target");
  assert.equal(rowTarget(1000), 180);
  const walk = (stop, direction, times) => {
    for (let index = 0; index < times; index++) stop = galleryZoomStep(stop, direction);
    return stop;
  };
  assert.equal(galleryZoomStep("medium", 1), "large");
  assert.equal(galleryZoomStep("large", 1), "large");
  assert.equal(galleryZoomStep("medium", -1), "small");
  assert.equal(galleryZoomStep("small", -1), "months");
  assert.equal(walk("medium", -1, 3), "years");
  assert.equal(walk("medium", -1, 9), "years");
  assert.equal(galleryZoomStep("years", 1), "months");
  assert.equal(galleryZoomStep("months", 1), "small", "spreading out of Months lands on the smallest rows");
});

test("trackpad pinch input adds up to one step per 1.35x and forgets a pause", () => {
  const step = pinchSteps();
  assert.equal(step(0.1, 0), 0);
  assert.equal(step(0.1, 16), 0);
  assert.equal(step(0.11, 32), 1, "spread past 1.35x is one step closer");
  assert.equal(step(0.2, 48), 0, "the step consumed what came before it");
  assert.equal(step(-0.1, 2000), 0, "a pause forgets the leftover");
  assert.equal(step(-0.25, 2016), -1);
  assert.equal(step(Number.NaN, 2032), 0);
  const wheel = pinchSteps();
  let moves = 0;
  for (let index = 0; index < 10; index++) moves += wheel(4 / 100, index * 16);
  assert.equal(moves, 1, "ten small ctrl+wheel deltas of a pinch-out make one step");
});

test("the gallery page takes ctrl+wheel and Safari gestures for itself and sizes rows by the pinch", () => {
  const app = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  assert.match(app, /wheel: \(event\) => \{\s*if \(!event\.ctrlKey\) return;\s*event\.preventDefault\(\);/);
  for (const name of ["gesturestart", "gesturechange", "gestureend"])
    assert.match(app, new RegExp(`${name}: \\(event\\) =>[\\s{]*event\\.preventDefault\\(\\)`));
  assert.match(app, /const surface = root\.closest\("\.page"\) \|\| root;\s*for \(const \[name, handler\] of Object\.entries\(pinchHandlers\)\)\s*surface\.addEventListener\(name, handler, \{ passive: false \}\);/);
  assert.match(app, /state\.cleanup = \(\) => \{\s*state\.unpinch\(\);/);
  assert.doesNotMatch(app, /(window|document)\.addEventListener\(\s*"wheel"/);
  assert.match(app, /target: rowTarget\(width, galleryZoom\)/);
  assert.match(app, /const next = galleryZoomStep\(galleryZoom, direction\);/);
  assert.doesNotMatch(app, /gallery-zoom|galleryZoomControl|galleryRowSize/, "the gallery has no zoom control beside the pinch");
});

test("a gallery summary counts photos and videos apart with singular forms and no zero part", () => {
  assert.equal(mediaSummary(0, 2), "2 videos");
  assert.equal(mediaSummary(3, 1), "3 photos · 1 video");
  assert.equal(mediaSummary(1, 0), "1 photo");
  assert.equal(mediaSummary(3046, 593), "3,046 photos · 593 videos");
  assert.equal(mediaSummary(0, 0), "0 photos");
  const app = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  const update = app.slice(app.indexOf("function updateSummary(data)"), app.indexOf("function updateTimeline(data)"));
  assert.match(update, /mediaSummary\(total - videos, videos\)/);
  const pattern = new RegExp(update.match(/replace\(\s*\/(.+)\/,/)[1]);
  assert.match("2 videos · 15.5 MB", pattern, "a videos-only summary is replaced again on the next timeline");
  assert.match("2 files · 15.5 MB", pattern);
});

test("a month heading sticks over the page background with a fade that shows only while photos pass under it", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] || "";
  const heading = rule(".photo-day h2");
  assert.match(heading, /position: sticky;/);
  assert.match(heading, /top: 0;/);
  assert.match(heading, /background: var\(--paper\);/);
  assert.doesNotMatch(heading, /border|box-shadow|border-radius/, "plain type, never a box");
  const fade = rule(".photo-day h2::after");
  assert.match(fade, /linear-gradient\(var\(--paper\), transparent\)/);
  assert.match(fade, /opacity: 0;/);
  assert.match(rule(".photo-day-stuck > h2::after"), /opacity: 1;/);
  assert.doesNotMatch(css, /\.photo-block|\.photo-day-name|\.gallery-zoom|--label-(top|left|width)/, "day labels and the zoom control leave no styles behind");
});

test("On this day cards are fixed 4:3 photos at the wall's row height in one sideways row", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const rules = (selector) => [...css.matchAll(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "g"))].map((match) => match[1]).join("");
  const grid = rules(".memory-grid");
  assert.match(grid, /grid-auto-flow: column;/);
  assert.match(grid, /overflow-x: auto;/);
  assert.match(grid, /justify-content: start;/);
  assert.doesNotMatch(grid, /scrollbar-width: none|scroll-snap-type/, "the default scrollbar lets mouse users reach overflowing cards");
  assert.doesNotMatch(rules(".memory-card"), /scroll-snap-align/);
  assert.doesNotMatch(grid, /1fr|grid-template-columns/, "cards never stretch to fill");
  const card = rules(".memory-card");
  assert.match(card, /height: var\(--photo-row, /);
  assert.match(card, /aspect-ratio: 4 \/ 3;/);
  assert.doesNotMatch(css.slice(css.indexOf("@media (max-width: 760px)")), /\.memory-grid \{[^}]*grid-template-columns/);
  const app = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  assert.match(app, /const row = rowTarget\(root\.querySelector\("\.photo-days"\)\.clientWidth, galleryZoom\);\s*put\(root, "--photo-row", `\$\{row\}px`\);/, "the cards read the wall's own row target");
});

const fakeCard = () => ({ dataset: {}, shown: [] });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an On this day card retries a busy preview and ends with the image", async () => {
  const card = fakeCard();
  let calls = 0;
  const retries = [];
  const request = cardPreviews({
    load: async (item, size) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("Previews are busy. Try again."), { status: 429 });
      return `${item.path}:${size}`;
    },
    show: (target, data) => target.shown.push(data),
    busy: (error) => error.status === 429,
    retry: (target, again) => retries.push(again),
  });
  await request(card, { path: "a.jpg" }, "medium");
  assert.equal(card.dataset.source, undefined, "a busy answer never marks the card as shown");
  assert.equal(retries.length, 1);
  await request(card, { path: "a.jpg" }, "medium");
  assert.equal(calls, 2, "a card not yet shown asks again while its retry is pending");
  assert.deepEqual(card.shown, ["a.jpg:medium"]);
  assert.equal(card.dataset.source, "medium");
  await retries[0]();
  assert.equal(calls, 2, "the late retry skips a size already shown");
});

test("an On this day card keeps the larger preview when a smaller one answers late", async () => {
  const card = fakeCard();
  const pending = {};
  const request = cardPreviews({
    load: (item, size) => new Promise((resolve) => (pending[size] = resolve)),
    show: (target, data) => target.shown.push(data),
    busy: () => false,
    retry: () => assert.fail("no retry"),
  });
  const small = request(card, {}, "thumb");
  const large = request(card, {}, "large");
  void request(card, {}, "medium");
  assert.equal(pending.medium, undefined, "a smaller size never queues behind a larger one in flight");
  pending.large("large");
  await large;
  pending.thumb("thumb");
  await small;
  await settle();
  assert.deepEqual(card.shown, ["large"]);
  assert.equal(card.dataset.source, "large");
});

test("an On this day card is not marked shown when it left the page before its preview arrived", async () => {
  const card = fakeCard();
  const request = cardPreviews({ load: async () => "data", show: () => false, busy: () => false, retry: () => {} });
  await request(card, {}, "medium");
  assert.equal(card.dataset.source, undefined);
});

test("On this day cards load through the busy-aware card loader", () => {
  const app = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  const sizeRow = app.slice(app.indexOf("function sizeRow() {"), app.indexOf("function layoutPhotos("));
  assert.match(sizeRow, /cardPreview\(card, item, coverPreviewSize\(\(row \* 4\) \/ 3, row, window\.devicePixelRatio \|\| 1, item\?\.width \|\| shown\?\.naturalWidth, item\?\.height \|\| shown\?\.naturalHeight\)\)/);
  assert.doesNotMatch(sizeRow, /dataset\.source = /);
  assert.match(app, /const cardPreview = cardPreviews\(\{[\s\S]*?busy: busyPreview,[\s\S]*?retryLater\(card/);
});
