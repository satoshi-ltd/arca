import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const css = read("apps/desktop/src/style.css");
const app = read("apps/desktop/src/app.js");
const pages = ["design/index.html", "design/desktop.html"].map(read).join("\n");
const rule = (selector) =>
  css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];

test("buttons come in four kinds and two sizes, with no text button and no outlined danger", () => {
  for (const source of [css, app, pages]) assert.doesNotMatch(source, /text-button/);
  assert.doesNotMatch(app, /"secondary danger"|"secondary small-button danger"|"primary danger"|secondary danger photo/);
  assert.doesNotMatch(pages, /class="secondary danger|class="secondary small-button danger/);
  assert.match(rule(".danger"), /background: var\(--er\);[^}]*border-color: transparent;[^}]*color: var\(--onGreen\);/);
  assert.match(rule(".menu-items .danger"), /color: var\(--erFg\);/);
  assert.match(rule(".ghost,\n.back"), /border-color: transparent;\s+background: transparent;\s+color: var\(--ink\);/);
  assert.match(rule(".ghost:hover,\n.back:hover"), /background: var\(--hover\);/);
  assert.doesNotMatch(rule(".ghost:hover,\n.back:hover"), /underline/);
  assert.match(rule(".icon-button"), /width: var\(--control-height\);\s+height: var\(--control-height\);/);
  assert.match(rule(".icon-button.small-button"), /width: var\(--button-small-height\);\s+height: var\(--button-small-height\);/);
  assert.match(rule(".small-button"), /min-height: var\(--button-small-height\);[^}]*padding: var\(--space-1\) var\(--space-2\);/);
  assert.doesNotMatch(css, /#sync-controls \.ghost\.icon-button \{/);
});

test("one inline message in neutral, warning and error tones replaces callouts, path checks and field errors", () => {
  for (const source of [css, app, pages]) assert.doesNotMatch(source, /callout|path-check-error|selection-check|selection-hint|field-error|class="path-check/);
  assert.match(rule(".message"), /padding: var\(--space-2\) var\(--space-3\);[^}]*border-radius: var\(--r-control\);[^}]*background: var\(--idBg\);[^}]*color: var\(--idFg\);/);
  assert.match(rule(".message > svg"), /width: var\(--row-icon\);[^}]*margin-top: calc\(\(var\(--text-body-line\) - var\(--row-icon\)\) \/ 2\);/);
  assert.match(rule(".message-warning"), /background: var\(--waBg\);\s+color: var\(--waFg\);/);
  assert.match(rule(".message-error"), /background: var\(--erBg\);\s+color: var\(--erFg\);/);
  assert.match(app, /function setMessage\(row, text, tone = ""\) \{\n  row\.className = `message\$\{tone \? ` message-\$\{tone\}` : ""\}`;/);
  assert.match(app, /setMessage\(line, short/);
  assert.match(app, /setMessage\(rejected, escape\(error\.message\), "error"\)/);
  assert.doesNotMatch(rule(".dialog-error"), /border:/);
});

test("fields read label, field, then one hint under it, and an invalid field turns its border to the error tone", () => {
  assert.match(rule("label"), /font-size: var\(--text-body\);\s+font-weight: 600;/);
  assert.match(rule(".hint"), /line-height: var\(--text-caption-line\);/);
  assert.match(css, /\n\.field-with-icon \+ \.hint,\ninput \+ \.hint,\ntextarea \+ \.hint,\nselect \+ \.hint \{\n  margin-top: var\(--space-1\);/);
  assert.match(css, /\n:where\(input, select, textarea\)\[aria-invalid="true"\],\n\.field-with-icon:has\(\[aria-invalid="true"\]\) \{\n  border-color: var\(--er\);/);
  assert.doesNotMatch(app, /\.classList\.contains\("hint"\) \? hint/);
});

test("rows share one geometry and a folder not selected is a paper row, not a dashed one", () => {
  assert.doesNotMatch(css, /\.folder-list:has\(> \.folder-card\.unselected\)|folder-card\.unselected \+ \.folder-card\.unselected/);
  assert.match(rule(".folder-card.unselected"), /background: var\(--paper\);/);
  assert.doesNotMatch(rule(".folder-card.unselected"), /dashed/);
  assert.match(rule(".device-row.discovered"), /background: var\(--paper\);/);
  for (const selector of [".folder-card", ".device-row", ".role-card", ".backup-card", ".resume-card", ".update-card"]) {
    const body = rule(selector);
    assert.match(body, /padding: var\(--row-padding-y\) var\(--row-padding-x\);/, `${selector} pads like a row`);
    assert.match(body, /gap: (var\(--space-2\) )?var\(--row-gap\);/, `${selector} keeps the row gap`);
  }
  for (const selector of [".device-row", ".role-card", ".backup-card", ".resume-card", ".update-card"])
    assert.match(rule(selector), /border-radius: var\(--r-control\);/, `${selector} rounds like a row`);
  assert.doesNotMatch(rule(".backup-card"), /dashed/);
  assert.match(rule(".role-card:has(input:checked)"), /border-color: var\(--green\);\s+box-shadow: inset 0 0 0 1px var\(--green\);/);
  assert.doesNotMatch(rule(".role-card:has(input:checked)"), /padding/);
  assert.match(rule(".copies-card"), /border-radius: var\(--r-surface\);/);
});

test("menus round like every other surface and keep control-radius items inside an 8 padded frame", () => {
  const menu = rule(".menu-items");
  assert.match(menu, /padding: var\(--space-2\);\s+border-radius: var\(--r-surface\);/);
  assert.match(rule("dialog"), /padding: var\(--space-6\);/);
  assert.match(rule(".panel"), /border-radius: var\(--r-surface\);\s+padding: var\(--space-4\);/);
  assert.match(rule(".empty"), /border: 1px dashed var\(--line\);\s+border-radius: var\(--r-surface\);/);
});

test("dropdowns and the tray's ⋯ menu share the ⋯ menu's frame and its control-radius rows", () => {
  const frame = /padding: var\(--space-2\);[^}]*border-radius: var\(--r-surface\);[^}]*box-shadow: var\(--shadow-menu\);/;
  const dropdown = rule(".dropdown-menu");
  assert.match(dropdown, frame);
  assert.doesNotMatch(dropdown, /border:/, "the shadow ring is the only edge");
  assert.match(dropdown, /min-width: 100%;/, "a dropdown keeps its trigger's width");
  assert.match(rule('.dropdown-menu [role="option"]'), /border-radius: var\(--r-control\);/);
  assert.match(rule('.dropdown-menu [aria-selected="true"]'), /background: var\(--tint\);/);
  assert.match(rule('.dropdown-menu [aria-selected="true"] .icon'), /visibility: visible;/);
  assert.match(css, /\}\n\.dropdown-menu \[role="option"\]:focus-visible \{\s+outline: 2px solid var\(--green\);\s+outline-offset: -2px;\s+\}/);
  assert.doesNotMatch(css.slice(css.indexOf("\n.dropdown-menu {"), css.indexOf("\n.machine-role {")), /outline: 1px|border: 1px/);
  assert.match(rule('.dropdown-menu [role="option"]:not([aria-selected="true"]):is(:hover, :focus-visible)'), /background: var\(--track\);/, "the selected row keeps its tint under the pointer and the focus ring");
  assert.doesNotMatch(css, /\.dropdown-menu \[role="option"\]:(hover|focus-visible)[,\s][^}]*background:/);
  assert.match(rule(".tray-menu.tray-more-menu"), /padding: var\(--space-2\);\s+border-radius: var\(--r-surface\);\s+background: var\(--notice-surface\);\s+box-shadow: 0 0 0 1px var\(--line\);/, "the tray ⋯ sits in the clipped popover, so it keeps only the ring");
  assert.match(css, /\}\n\.tray-menu button \{\s+padding: var\(--space-2\) var\(--space-2\);\s+border-radius: var\(--r-control\);/);
  assert.match(rule(".tray-folders button,\n.tray-menu button"), /line-height: var\(--text-control-line\);/);
  assert.doesNotMatch(css.slice(css.indexOf("\n.tray-body {"), css.indexOf("\n#connection {")), /line-height: \d+px/);
});

test("the desktop sidebar fits the status line and both sync controls on one row", () => {
  const tokens = read("apps/desktop/src/tokens.css");
  const css = read("apps/desktop/src/style.css");
  assert.match(tokens, /--sidebar-width: 240px;/);
  assert.match(css, /\.sync-status-heading strong \{[^}]*white-space: nowrap;/);
});

test("inline messages announce errors and draw their icon, loading rows are solid and the setup line leaves no empty box", () => {
  assert.match(app, /function inlineMessage\(text, tone = ""\) \{\n  return `<div class="message\$\{tone \? ` message-\$\{tone\}` : ""\}" role="\$\{tone === "error" \? "alert" : "status"\}">/);
  assert.match(app, /function setMessage\(row, text, tone = ""\) \{\n  row\.className = [^\n]+\n  row\.setAttribute\("role", tone === "error" \? "alert" : "status"\);/, "a path check turning into an error is announced");
  for (const line of app.split("\n").map((text, index, all) => [text, all[index + 1]]).filter(([text]) => /wait\.innerHTML = inlineMessage\(/.test(text)))
    assert.match(line[1], /^\s+icons\(\);$/, "the approval error hydrates its icon");
  for (const source of [css, app, pages]) assert.doesNotMatch(source, /scaffold-dashed/);
  assert.doesNotMatch(app, /scaffoldRow\("card", true\)/);
  assert.match(app, /if \(\$\("#setup-space"\)\) \{\n      \$\("#setup-space"\)\.className = "";\n      \$\("#setup-space"\)\.innerHTML = "";/);
  const tokens = read("apps/desktop/src/tokens.css");
  assert.equal(tokens.split("\n")[0], "/* Generated by design/build.js from packages/core/design-tokens.js; do not edit. */");
});

test("every row on a card hovers with the hover tone, menu rows with the track tone, and only the sidebar keeps the surface tone", () => {
  const hover = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return /background: var\(--([a-z-]+)\)/.exec(css.slice(at, css.indexOf("}", at)))[1];
  };
  for (const row of ['.history-row[role="button"]:hover', ".browser-file-row:hover", ".music-row:hover", ".music-track:not(.music-track-head, .music-track-missing):hover", ".video-episode:hover", ".palette-open:hover", ".tray-folders button:hover", ".folder-card:hover", ".photo-viewer .photo-info button:hover", ".photo-viewer .photo-info button:hover:not(:disabled)"])
    assert.equal(hover(row), "hover", row);
  assert.equal(hover(".tray-menu button:hover"), "track");
  assert.equal(hover(".nav-item:hover"), "surface");
});
