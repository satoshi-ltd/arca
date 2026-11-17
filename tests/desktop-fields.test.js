import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const style = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("fields keep their 3:1 edge around a fill, and their focus and error are an inset line", () => {
  assert.match(style, /input,\nselect,\ntextarea \{\n  width: 100%;\n  min-width: 0;\n  border: 1px solid var\(--control\);\n  background: var\(--hover\);/);
  assert.match(style, /\.field-with-icon \{[^}]*border: 1px solid var\(--control\);[^}]*background: var\(--hover\);/);
  assert.match(style, /input:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\]\):focus,\nselect:focus,\ntextarea:focus \{[^}]*border-color: transparent;\n  box-shadow: inset 0 0 0 1\.5px var\(--ink\);/, "checkboxes and radios keep their own focus");
  assert.doesNotMatch(style, /textarea:focus-visible \{\s*outline: 2px solid var\(--green\)/, "a text area has no green ring either");
  assert.match(style, /:is\(input, select, textarea\)\[aria-invalid="true"\]:focus,/, "the red line outranks the focus line");
  assert.match(style, /\.field-with-icon input\[aria-invalid="true"\]:focus,\n\.pal-field \.pal-input:focus \{\n  box-shadow: none;/, "a composite field draws its line on its frame, and the always-focused palette input draws none");
  assert.match(style, /\.field-with-icon:focus-within \{\n  border-color: transparent;\n  box-shadow: inset 0 0 0 1\.5px var\(--ink\);/);
  assert.match(style, /:is\(input, select, textarea\)\[aria-invalid="true"\]:focus,\n\.field-with-icon:has\(\[aria-invalid="true"\]\):focus-within \{\n  border-color: transparent;\n  box-shadow: inset 0 0 0 2px var\(--er\);/, "an invalid field keeps its red line while focused");
  assert.match(style, /:where\(input:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\]\), select, textarea\):hover:where\(:not\(:focus, :disabled\)\),[\s\S]*?\{\n  background: var\(--press\);/, "pointing deepens the fill: :hover outside :where, so it outranks the base fill (0,0,1) while composite and palette inputs (0,1,1 and later 0,1,0) keep their own");
  assert.doesNotMatch(style, /:focus,\nselect:focus[^}]*--focus-ring/, "no green ring around a field");
});

test("settings inputs share one 280 px column", () => {
  assert.match(style, /\.setting-row input \{\n  width: 280px;/);
});
