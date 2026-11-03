import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (name) => fs.readFileSync(new URL(`../apps/mobile/src/${name}`, import.meta.url), "utf8");

test("the phone's hub row ends in a ⋯ that opens Change address… and Disconnect…", () => {
  const hub = read("HubConnection.jsx");
  assert.match(hub, /icon="more" label=\{`Actions for \$\{name \|\| "Hub"\}`\}/);
  assert.match(hub, /onPress=\{actions\} \/>/);
  assert.match(hub, /label="Retry disconnect"/, "a pending disconnect keeps its retry");
  const app = read("App.jsx");
  const menu = app.slice(app.indexOf('shownSheet.kind === "hub-actions" && ('), app.indexOf('shownSheet.kind === "hub-address" && ('));
  assert.ok(menu.indexOf('label="Change address…"') < menu.indexOf('label="Disconnect…"'), "Change address… comes first");
  assert.match(menu.slice(menu.indexOf('label="Disconnect…"')), /danger/);
  assert.match(app, /setSheet\(\{ kind: "hub-actions" \}\)/);
});

test("Change address on the phone saves through the client with the replica's checks and reports success", () => {
  const app = read("App.jsx");
  const sheet = app.slice(app.indexOf('shownSheet.kind === "hub-address" && ('), app.indexOf('shownSheet.kind === "rename-file" && ('));
  assert.match(sheet, /label="New address"/);
  assert.match(sheet, /await client\.relocate\(hubURL, await r\.relocationChecks\(\)\)/);
  assert.match(sheet, /success: `Hub address changed\. Syncing with/);
  assert.match(sheet, /r\.stop\(\);\s*if \(r\.active\) await r\.active;/, "sync stops before the address changes");
});

test("a folder row can carry a role tag before its chevron, read aloud after its caption", () => {
  const components = read("components.jsx");
  const row = components.slice(components.indexOf("export function FolderRow("), components.indexOf("const TABS = "));
  assert.match(row, /\{!!tag && <Tag>\{tag\.toUpperCase\(\)\}<\/Tag>\}\s*<View style=\{s\.rowAction\}>/);
  assert.match(row, /\$\{tag \? `, \$\{tag\}` : ""\}/);
});
