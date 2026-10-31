import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const components = fs.readFileSync(new URL("../apps/mobile/src/components.jsx", import.meta.url), "utf8");
const row = components.slice(components.indexOf("export function FolderRow("), components.indexOf("\nexport function", components.indexOf("export function FolderRow(") + 1));

test("a folder the hub offers is one pressable row that opens Start syncing and ends in the chevron, with no button", () => {
  assert.doesNotMatch(row, /<Button\b/);
  const offered = row.slice(row.indexOf("return available ? ("), row.indexOf(") : (", row.indexOf("return available ? (")));
  assert.match(offered, /<PressScale\b/);
  assert.match(offered, /accessibilityRole="button"/);
  assert.match(offered, /accessibilityLabel=\{`Start syncing \$\{name\}/);
  assert.match(offered, /onPress=\{onPress\}/);
  assert.match(offered, /s\.availableRow/);
  assert.match(row, /<View style=\{s\.rowAction\}>\s*<Icon name="chevron"/);
});
