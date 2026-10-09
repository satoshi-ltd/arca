import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { geometry } from "../apps/mobile/src/design-tokens.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const tokens = read("../apps/desktop/src/tokens.css");
const style = read("../apps/desktop/src/style.css");
const theme = read("../apps/mobile/src/theme.js");

test("rows share one gap, one padding and one section rhythm", () => {
  for (const [name, value] of [["row-gap", "12px"], ["row-padding-y", "12px"], ["row-padding-x", "16px"], ["section-gap", "24px"], ["section-label-gap", "8px"]])
    assert.match(tokens, new RegExp(`--${name}: ${value};`));
  assert.deepEqual(
    [geometry.rowGap, geometry.rowPaddingY, geometry.rowPaddingX, geometry.rowMinHeight, geometry.sectionGap, geometry.sectionLabelGap],
    [12, 12, 16, 48, 24, 8],
  );
});

test("no desktop row class sets its own padding or spacing outside the tokens", () => {
  for (const selector of [".folder-card", ".device-row", ".history-row", ".setting-row", ".browser-file-row", ".music-row"]) {
    const rule = new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "g");
    for (const match of style.matchAll(rule)) {
      const padding = match[1].match(/padding:\s*([^;]+);/);
      if (padding) assert.match(padding[1], /var\(--row-padding-y\) var\(--row-padding-x\)|^0 /, `${selector} padding`);
      assert.doesNotMatch(match[1], /margin-bottom:\s*\d+px/, `${selector} spacing`);
    }
  }
  assert.match(style, /\.device-row \+ \.device-row \{\s*margin-top: var\(--row-gap\);/);
});

test("no phone row style declares its own vertical padding", () => {
  for (const key of ["folderRow", "machineRow", "settingRow", "actionRow", "musicTrack"]) {
    const rule = theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1];
    assert.match(rule, /paddingVertical: g\.rowPaddingY/, key);
    assert.doesNotMatch(rule, /paddingVertical: \d/, key);
  }
  for (const key of ["machineRow", "settingRow", "actionRow"])
    assert.match(theme.match(new RegExp(`\\n    ${key}: \\{([^}]*)\\}`))[1], /minHeight: g\.rowMinHeight/, key);
});
