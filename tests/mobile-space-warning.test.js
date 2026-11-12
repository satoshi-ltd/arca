import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HEADROOM, neededBytes, notEnoughSpace, spaceShort } from "../apps/mobile/src/space.js";
import { HEADROOM as engineHeadroom } from "../apps/mobile/src/replica.js";

const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");

test("the sheet judges fit with the same headroom the engine refuses at", () => {
  assert.equal(HEADROOM, engineHeadroom);
  assert.equal(spaceShort(1000, 1000 + HEADROOM), false);
  assert.equal(spaceShort(1001, 1000 + HEADROOM), true);
  assert.equal(spaceShort(undefined, 5), false, "an uncounted folder never warns");
  assert.equal(spaceShort(5, undefined), false, "unknown free space never warns");
  assert.equal(spaceShort(NaN, 5), false);
});

test("what a folder still needs counts its own local bytes and the other selected folders' remainder", () => {
  const hub = [
    { id: "a", bytes: 1000 },
    { id: "b", bytes: 500 },
    { id: "gone", bytes: 900 },
  ];
  const local = [
    { id: "a", selected: 0, bytes: 400 },
    { id: "b", selected: 1, bytes: 100 },
    { id: "c", selected: 1, bytes: 50 },
    { id: "gone", selected: 0, bytes: 0 },
  ];
  assert.equal(neededBytes(hub[0], local, hub), 600 + 400, "its own copy is credited, the other folder still owes 400");
  assert.equal(neededBytes(hub[0], [], hub), 1000);
  assert.equal(neededBytes({ id: "a", bytes: 100 }, local, hub), 400, "a copy larger than the folder owes nothing");
  assert.equal(spaceShort(neededBytes(hub[0], local, hub), 1000 + HEADROOM), false, "a folder the engine would accept never shows red");
  assert.equal(spaceShort(hub[0].bytes, 1000 + HEADROOM - 1), true);
  assert.equal(spaceShort(neededBytes(hub[0], [{ id: "a", selected: 0, bytes: 400 }], hub), 600 + HEADROOM), false);
});

test("the sheet and the engine share the formula, and a folder that does not fit turns the line red with Start syncing off", () => {
  assert.match(fs.readFileSync(new URL("../apps/mobile/src/replica.js", import.meta.url), "utf8"), /neededBytes\(volume, folders,/);
  assert.match(app, /neededBytes\(shownSheet\.volume, sheetFolders, volumes\)/);
  assert.match(app, /\[s\.caption, tooBig && s\.errorText\]/);
  assert.match(app, /label="Start syncing"\s+icon="refresh"\s+primary\s+disabled=\{tooBig\}/);
  assert.match(app, /\? notEnoughSpace\(sheetNeeds, status\.free\)/);
});

test("onboarding warns before Start syncing when the ticked folders do not fit, with the sheet's check and wording", () => {
  assert.equal(notEnoughSpace(13.4 * 1024 ** 3, 8.1 * 1024 ** 3), "Not enough space: 13.4 GB to download · 8.1 GB free");
  const screen = fs.readFileSync(new URL("../apps/mobile/src/Onboarding.jsx", import.meta.url), "utf8");
  assert.match(screen, /import \{ notEnoughSpace, spaceShort \} from "\.\/space\.js";/);
  assert.match(screen, /const needed = downloadBytes\(chosen, modes\);\s+const short = spaceShort\(needed, free\);/, "recomputed on every tick and Stream choice");
  assert.match(screen, /<Text style=\{\[s\.caption, s\.centerText, short && s\.errorText\]\}>\s+\{short \? \(\s+notEnoughSpace\(needed, free\)/);
  assert.match(screen, /disabled=\{!chosen\.length \|\| short\}\s+reason=\{short \? notEnoughSpace\(needed, free\) : undefined\}/, "screen readers hear why Start syncing is off");
  assert.match(screen, /<Button\s+label="Skip for now"\s+ghost\s+busy=\{busy\}\s+onPress=\{skip\}/, "Skip for now stays available");
});
