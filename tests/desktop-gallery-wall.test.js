import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
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

const days = (...lists) => lists.map((ratios) => ({ ratios, label: true }));
const wall = { width: 1000, target: 180, gap: 6, label: 24 };
const rowsOf = (flow) => flow.rows.map((row) => flow.tiles.slice(row.start, row.end));
const right = (tiles) => tiles.at(-1).left + tiles.at(-1).width;

test("rows fill the width at the target height and the last row keeps it", () => {
  const flow = photoFlow(days([1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 0.75]), wall);
  for (const tiles of rowsOf(flow).slice(0, -1)) {
    assert.ok(Math.abs(right(tiles) - 1000) < 0.5, `row fills ${right(tiles)}`);
    assert.ok(tiles[0].height <= 225);
  }
  assert.ok(flow.rows.at(-1).height <= 180);
  assert.equal(flow.tiles.length, 7);
});

test("sparse days flow into the same rows, each labelled above its own first tile", () => {
  const flow = photoFlow(days([1.5], [1.5], [0.75, 0.75], [1.5, 1.5], [1.5]), wall);
  assert.equal(flow.rows[0].start, 0);
  assert.ok(flow.tiles[flow.rows[0].end - 1].chunk >= 2, "the first three days share the first row");
  assert.deepEqual(flow.labels.map((label) => label.chunk), [0, 1, 2, 3, 4]);
  for (const label of flow.labels) {
    const first = flow.tiles.find((tile) => tile.chunk === label.chunk);
    assert.equal(label.left, first.left);
    assert.equal(label.top, first.top - 24, "a label sits right above its day's first tile");
    const segment = flow.tiles.filter((tile) => tile.chunk === label.chunk && tile.row === label.row);
    assert.ok(Math.abs(label.width - (right(segment) - first.left)) < 0.02, "a label spans its day's tiles in that row");
  }
  const pairs = flow.tiles.slice(1).map((tile, index) => [flow.tiles[index], tile]).filter(([c, d]) => c.row === d.row);
  assert.ok(pairs.some(([c, d]) => c.chunk !== d.chunk) && pairs.some(([c, d]) => c.chunk === d.chunk));
  for (const [c, d] of pairs) assert.ok(Math.abs(d.left - (c.left + c.width) - 6) < 0.02, "every neighbour in a row, the next day's first photo included, sits one tile gap apart");
});

test("a long day continues on the next rows with its label only above its first row", () => {
  const flow = photoFlow(days([1.5], Array(40).fill(1.33), [1.5]), wall);
  const long = flow.labels.filter((label) => label.chunk === 1);
  assert.equal(long.length, 1);
  const rows = rowsOf(flow);
  assert.ok(rows.length > 5);
  assert.ok(rows[0].some((tile) => tile.chunk === 1), "the long day starts right after the short one");
  for (let index = 1; index < rows.length; index++) {
    const labelled = rows[index].some((tile) => tile.index === 0);
    const gap = flow.rows[index].top - (flow.rows[index - 1].top + flow.rows[index - 1].height);
    assert.ok(Math.abs(gap - (labelled ? 6 + 24 : 6)) < 0.02, `row ${index} reserves label room only when a day starts in it`);
  }
  assert.equal(flow.labels.at(-1).chunk, 2);
  assert.ok(Math.abs(flow.height - (flow.rows.at(-1).top + flow.rows.at(-1).height)) < 0.02);
});

test("photos without a day get no label", () => {
  const flow = photoFlow([{ ratios: [1.5, 1.5], label: false }], wall);
  assert.deepEqual(flow.labels, []);
  assert.equal(flow.rows[0].top, 0);
});

test("a later day can change only the row its first photo lands in and the row before it", () => {
  for (const [kept, added] of [
    [days([1.5, 1.5], [1.5], [1.33, 1.33, 1.5], [1.5]), [0.75, 1.5, 1.5]],
    [days([1.33, 1.33, 1.33, 1.33]), [1.33]],
    [days([1.5, 1.5, 1.33, 0.75], [1.5]), [3, 1.5]],
  ]) {
    const before = photoFlow(kept, wall);
    const after = photoFlow([...kept, { ratios: added, label: true }], wall);
    const from = Math.max(0, after.tiles.find((tile) => tile.chunk === kept.length).row - 1);
    assert.deepEqual(after.tiles.filter((tile) => tile.row < from), before.tiles.filter((tile) => tile.row < from));
  }
  const kept = days([1.33, 1.33, 1.33, 1.33]);
  const before = photoFlow(kept, wall);
  const after = photoFlow([...kept, { ratios: [1.33], label: true }], wall);
  assert.equal(after.tiles[4].row, 1, "the new day starts the next row");
  assert.equal(before.tiles[0].height, 180);
  assert.ok(after.tiles[0].height > 180, "and the row above, until now the month's last, closes taller");
  const right = after.tiles[3].left + after.tiles[3].width;
  assert.ok(Math.abs(right - 1000) < 0.5, `the closed row fills the wall (${right})`);
});

test("the gallery scroll keeps only its own anchor", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  assert.match(css, /\n#photo-gallery \{[^}]*overflow-anchor: none;/);
  assert.match(css, /\n\.page:has\(#photo-gallery\) \{\s*overflow-anchor: none;\s*\}/);
});

test("a panorama on a narrow wall does not squash the row before it", () => {
  const flow = photoFlow(days([1.78, 4, 1.33]), { ...wall, width: 234, target: 120 });
  assert.deepEqual(flow.rows.map((row) => row.end - row.start), [1, 1, 1]);
  assert.ok(flow.rows[0].height > 120 && flow.rows[0].height <= 150, String(flow.rows[0].height));
  assert.ok(flow.rows[1].height >= 234 / 4 - 1);
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

test("a pinch walks Years, Months and three Days row heights, and stops at both ends", () => {
  assert.deepEqual([rowTarget(1000, 0), rowTarget(1000, 1), rowTarget(1000, 2)], [120, 180, 240]);
  assert.equal(rowTarget(700, 1), 140, "the middle step is the wall's own target");
  assert.equal(rowTarget(1000), 180);
  const walk = (zoom, size, direction, times) => {
    let view = { zoom, size };
    for (let index = 0; index < times; index++) view = galleryZoomStep(view.zoom, view.size, direction);
    return view;
  };
  assert.deepEqual(galleryZoomStep("days", 1, 1), { zoom: "days", size: 2 });
  assert.deepEqual(galleryZoomStep("days", 2, 1), { zoom: "days", size: 2 });
  assert.deepEqual(galleryZoomStep("days", 1, -1), { zoom: "days", size: 0 });
  assert.deepEqual(galleryZoomStep("days", 0, -1), { zoom: "months", size: 0 });
  assert.deepEqual(walk("days", 1, -1, 2).zoom, "months");
  assert.deepEqual(walk("days", 1, -1, 3), { zoom: "years", size: 0 });
  assert.deepEqual(walk("days", 1, -1, 9), { zoom: "years", size: 0 });
  assert.deepEqual(galleryZoomStep("years", 1, 1), { zoom: "months", size: 1 });
  assert.deepEqual(galleryZoomStep("months", 2, 1), { zoom: "days", size: 0 }, "spreading out of Months lands on the smallest rows");
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
  assert.match(app, /target: rowTarget\(width, galleryRowSize\)/);
  assert.match(app, /galleryZoom = next\.zoom;\s*state\.setZoom\(\);/);
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
