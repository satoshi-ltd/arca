import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("the phone's Devices list gives the device that backs up the hub a shield segment on its role chip", () => {
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /backup=\{!!m\.backup\?\.enabled\}/);
  const components = read("../apps/mobile/src/components.jsx");
  const chip = components.slice(components.indexOf("export function RoleChip("), components.indexOf("export function MachineRow("));
  assert.match(chip, /accessibilityLabel="Full backup"/);
  assert.match(chip, /<Icon name="shield-check"/);
  assert.doesNotMatch(components, /BACKS UP HUB/);
});
