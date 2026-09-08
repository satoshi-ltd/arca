import test from "node:test";
import assert from "node:assert/strict";
import { isPickerCancelled } from "../apps/mobile/src/action-errors.js";

test("native picker cancellation is a normal exit, including wrapped Expo errors", () => {
  assert.equal(
    isPickerCancelled(
      new Error(
        "Call to function 'FileSystem.pickDirectoryAsync' has been rejected.\n→ Caused by: The file picker was cancelled by the user",
      ),
    ),
    true,
  );
  assert.equal(
    isPickerCancelled(
      new Error("The directory picker was cancelled by the user"),
    ),
    true,
  );
});

test("real export and filesystem failures are never suppressed as cancellation", () => {
  for (const message of [
    "Permission denied",
    "Export was cancelled because disk is full",
    "Network request failed",
    "File does not exist",
  ]) {
    assert.equal(isPickerCancelled(new Error(message)), false);
  }
  assert.equal(isPickerCancelled(null), false);
});
