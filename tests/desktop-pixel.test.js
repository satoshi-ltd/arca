import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { photoFlow } from "../apps/desktop/src/gallery-timeline-layout.js";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const css = read("apps/desktop/src/style.css");
const tokens = read("apps/desktop/src/tokens.css");
const token = (name) => Number(tokens.match(new RegExp(`--${name}: (\\d+)px;`))?.[1]);
const rule = (selector) =>
  css.match(new RegExp(`\\n\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];

test("photo wall tiles land on whole pixels, one exact gap apart, and full rows end at the wall's edge", () => {
  const width = 1037;
  const flow = photoFlow([1.5, 0.75, 1.33, 1.78, 1, 2.4, 0.66, 1.5, 1.33, 1.33, 0.8, 1.5, 3], { width, target: 173, gap: 6 });
  for (const tile of flow.tiles)
    for (const key of ["left", "top", "width", "height"]) assert.ok(Number.isInteger(tile[key]), `${key} ${tile[key]}`);
  assert.ok(Number.isInteger(flow.height));
  flow.rows.forEach((row, number) => {
    const tiles = flow.tiles.slice(row.start, row.end);
    for (let index = 1; index < tiles.length; index++)
      assert.equal(tiles[index].left - (tiles[index - 1].left + tiles[index - 1].width), 6);
    if (number < flow.rows.length - 1) assert.equal(tiles.at(-1).left + tiles.at(-1).width, width);
    if (number) assert.equal(row.top - (flow.rows[number - 1].top + flow.rows[number - 1].height), 6);
  });
  const sliver = photoFlow([0.022, 9.29], { width: 104, target: 120, gap: 6 });
  const [thin, wide] = sliver.tiles;
  assert.ok(thin.width >= 1);
  assert.equal(wide.row, thin.row);
  assert.equal(wide.left - (thin.left + thin.width), 6, "a sliver never eats the gap after it");
  const edge = photoFlow([2.404, 1.89, 0.002], { width: 895, target: 200, gap: 6 }).tiles;
  assert.ok(Math.max(...edge.map((tile) => tile.left + tile.width)) <= 895, "and never pushes its row past the wall");
});

test("desktop text lines are whole pixels: no fractional multiplier and every size has its line token", () => {
  assert.doesNotMatch(css, /line-height: \d*\.\d+/);
  assert.doesNotMatch(css, /font: [^;]*\/ \d*\.\d+/);
  assert.match(rule(".stat > strong"), /line-height: var\(--text-heading-line\);/);
  assert.match(rule(".photo-info-summary .mono"), /line-height: var\(--text-row-line\);/);
  assert.equal(token("text-row-line"), 18);
  assert.match(rule(".row-main"), /line-height: var\(--text-row-line\);/);
  assert.match(rule(".row-main p"), /line-height: var\(--text-body-line\);/);
  assert.match(rule(".mono,\ncode"), /line-height: var\(--text-caption-line\);/);
  assert.match(rule(".tray-menu kbd"), /font: var\(--text-caption\) \/ var\(--text-caption-line\) var\(--font-mono\);/);
  assert.match(rule(".device-cell"), /line-height: var\(--text-caption-line\);/);
  assert.match(rule(".update-mark"), /height: var\(--text-body-line\);/);
  assert.match(rule(".role-card strong"), /display: block;/);
  assert.match(rule(".video-facts"), /line-height: var\(--text-control-line\);/);
  assert.match(rule(".retention-stats .panel > .hint"), /display: block;/);
});

test("every busy grid's nine dots are whole pixels in the box it is drawn at", () => {
  const gapOf = (selector) => Number(rule(selector).match(/gap: ([\d.]+)px;/)[1]);
  const small = gapOf(".pill .busy-grid,\n.favorite-state .busy-grid");
  const boxes = [
    [Number(rule(".busy-grid").match(/width: (\d+)px;/)[1]), gapOf(".busy-grid")],
    [Number(rule(".favorite-state .busy-grid").match(/width: (\d+)px;/)[1]), small],
    [token("pill-icon"), small],
  ];
  for (const [size, gap] of boxes) assert.ok(Number.isInteger((size - 2 * gap) / 3), `${size}px box: dot ${(size - 2 * gap) / 3}`);
});

test("icons fit and centre in their boxes", () => {
  assert.match(rule(".music-row > .music-cover > svg,\n.music-artist-albums > .music-cover > svg,\n.resume-card > .music-cover > svg"), /width: 18px;/);
  const older = rule(".device-cells .device-older svg");
  assert.match(older, /margin-top: calc\(\(var\(--text-body-line\) - var\(--pill-icon\)\) \/ 2\);/);
  assert.match(older, /vertical-align: top;/);
  assert.ok(Number.isInteger((token("text-body-line") - token("pill-icon")) / 2));
});
