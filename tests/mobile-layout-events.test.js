import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = new URL("../apps/mobile/src/", import.meta.url);

test("a layout handler reads the event before a state updater runs, since React Native clears nativeEvent once the handler returns", () => {
  for (const name of fs.readdirSync(dir, { recursive: true }).filter((file) => /\.jsx?$/.test(file))) {
    const source = fs.readFileSync(new URL(name, dir), "utf8");
    const lazy = source.match(/set[A-Z]\w*\(\s*\(?[\w\s,]*\)?\s*=>\s*(?:\{[^}]*?|[^;{}]*?)\b(?:e|event|evt)\??\.nativeEvent/);
    assert.equal(lazy, null, `${name} reads event.nativeEvent inside a state updater: ${lazy?.[0]}`);
  }
});
