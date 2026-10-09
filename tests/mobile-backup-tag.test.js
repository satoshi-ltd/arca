import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("the phone's Devices list tags the device that backs up the hub", () => {
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /backup=\{!!m\.backup\?\.enabled\}/);
  const components = read("../apps/mobile/src/components.jsx");
  assert.match(components, /\{backup && <Tag>BACKS UP HUB<\/Tag>\}/);
});
