import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Android opts out of cloud backup and requests no overlay permission", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../apps/mobile/app.json", import.meta.url), "utf8")).expo;
  assert.equal(config.android.allowBackup, false);
  assert.ok(config.android.blockedPermissions.includes("android.permission.SYSTEM_ALERT_WINDOW"));
});
