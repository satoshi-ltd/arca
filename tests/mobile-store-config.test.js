import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const mobile = fileURLToPath(new URL("../apps/mobile/", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(path.join(mobile, file), "utf8"));

test("the store profile builds the Play app bundle while production stays a sideloadable APK", () => {
  const { build } = read("eas.json");
  assert.equal(build.store.extends, "base");
  assert.equal(build.store.android.buildType, "app-bundle");
  assert.equal(build.store.distribution, undefined);
  assert.equal(build.production.android.buildType, "apk");
  assert.ok(read("eas.json").submit.store, "eas submit --profile store");
});

test("store builds carry the purpose strings App Store processing checks and block what Arca never uses", () => {
  const { expo } = read("app.json");
  const plugin = (name) =>
    expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === name)?.[1];
  const sentence = (value) => typeof value === "string" && !value.includes("$(PRODUCT_NAME)") && value.length > 20;
  assert.equal(expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
  const disk = expo.ios.privacyManifests.NSPrivacyAccessedAPITypes.find(
    (entry) => entry.NSPrivacyAccessedAPIType === "NSPrivacyAccessedAPICategoryDiskSpace",
  );
  assert.deepEqual(disk?.NSPrivacyAccessedAPITypeReasons, ["E174.1"], "GalleryExport.swift checks free space before exporting");
  for (const permission of ["CAMERA", "SYSTEM_ALERT_WINDOW"])
    assert.ok(expo.android.blockedPermissions.includes(`android.permission.${permission}`), permission);
  // expo-image-picker and expo-media-library link camera and save-to-Photos APIs, so iOS needs
  // their purpose strings even though Arca never asks for either.
  const picker = plugin("expo-image-picker");
  const library = plugin("expo-media-library");
  assert.ok(sentence(picker.cameraPermission), "NSCameraUsageDescription");
  assert.ok(sentence(library.savePhotosPermission), "NSPhotoLibraryAddUsageDescription");
  assert.equal(picker.microphonePermission, false, "blocks RECORD_AUDIO");
  assert.ok(sentence(library.photosPermission), "NSPhotoLibraryUsageDescription");
  assert.equal(picker.photosPermission, library.photosPermission, "one photo-library purpose string");
  assert.deepEqual(library.granularPermissions, ["photo", "video"]);
});

test("Google Play offers the app to devices without Wi-Fi", () => {
  // ACCESS_WIFI_STATE (expo-network) implies android.hardware.wifi as a required feature unless
  // the manifest declares it optional; Play then hides the app from devices without Wi-Fi.
  const manifest = fs.readFileSync(path.join(mobile, "modules", "arca-network", "android", "src", "main", "AndroidManifest.xml"), "utf8");
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.wifi" android:required="false" \/>/);
  assert.doesNotMatch(manifest, /<uses-feature(?![^>]*android:required="false")[^>]*>/, "no required hardware feature");
});
